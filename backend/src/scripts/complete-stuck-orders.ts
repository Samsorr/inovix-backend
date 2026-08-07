import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { completeOrderWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Complete orders that are fully paid and fully shipped but still sit in
 * `pending`.
 *
 *   # see what it would do, changes nothing:
 *   medusa exec ./src/scripts/complete-stuck-orders.ts
 *
 *   # actually complete them:
 *   COMPLETE_STUCK_ORDERS_APPLY=1 medusa exec ./src/scripts/complete-stuck-orders.ts
 *
 * Why this exists: `feat(orders): auto-complete orders once fully captured`
 * deployed on 2026-07-21 15:56. Orders created before that moment were never
 * backfilled, so 28411 (paid, shipped, DELIVERED 2026-07-16) and 28412 (paid,
 * shipped) are still `pending`. Every order after the cutover completes
 * correctly. Left alone they stay pending forever, and anything keyed on
 * `status = 'pending'` (admin, Telegram /status, the unshipped-order alert)
 * reports two permanently open jobs that do not exist.
 *
 * Safety:
 * - DRY RUN by default. It only writes when COMPLETE_STUCK_ORDERS_APPLY=1.
 * - It re-derives the candidate list from live data every run rather than
 *   trusting hardcoded ids, so it cannot complete an order that does not
 *   currently satisfy every condition below.
 * - An order qualifies only if ALL of: status is `pending`, its payment
 *   collection is `completed`, captured amount is at least the order amount,
 *   nothing is refunded, and it has at least one fulfillment that is shipped
 *   and not cancelled.
 * - IDEMPOTENT: an already-completed order no longer matches, so re-running is
 *   a no-op.
 * - It uses `completeOrderWorkflow` rather than an UPDATE so the normal events
 *   and side effects fire, exactly as they would for an order completing on
 *   its own.
 */
export default async function completeStuckOrders({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const apply = process.env.COMPLETE_STUCK_ORDERS_APPLY === "1"

  // Read-only discovery. Kept as SQL because it spans three modules
  // (order, payment, fulfillment) and query.graph cannot traverse those links.
  const { rows } = await knex.raw(`
    SELECT o.id,
           o.display_id,
           o.created_at,
           pc.status            AS payment_status,
           pc.amount::numeric   AS amount,
           pc.captured_amount::numeric AS captured,
           pc.refunded_amount::numeric AS refunded,
           max(f.shipped_at)    AS shipped_at
      FROM "order" o
      JOIN order_payment_collection opc
        ON opc.order_id = o.id AND opc.deleted_at IS NULL
      JOIN payment_collection pc
        ON pc.id = opc.payment_collection_id AND pc.deleted_at IS NULL
      JOIN order_fulfillment ofu
        ON ofu.order_id = o.id AND ofu.deleted_at IS NULL
      JOIN fulfillment f
        ON f.id = ofu.fulfillment_id
       AND f.deleted_at IS NULL
       AND f.canceled_at IS NULL
       AND f.shipped_at IS NOT NULL
     WHERE o.deleted_at IS NULL
       AND o.status = 'pending'
       AND pc.status = 'completed'
       AND pc.captured_amount::numeric >= pc.amount::numeric
       AND coalesce(pc.refunded_amount::numeric, 0) = 0
     GROUP BY o.id, o.display_id, o.created_at, pc.status, pc.amount,
              pc.captured_amount, pc.refunded_amount
     ORDER BY o.display_id
  `)

  if (!rows.length) {
    logger.info("No stuck orders found. Nothing to do.")
    return
  }

  logger.info(`Found ${rows.length} paid + shipped order(s) still pending:`)
  for (const r of rows) {
    logger.info(
      `  #${r.display_id}  ${r.id}  created=${new Date(r.created_at).toISOString().slice(0, 10)}` +
        `  captured=${r.captured}/${r.amount}  shipped=${new Date(r.shipped_at).toISOString().slice(0, 10)}`
    )
  }

  if (!apply) {
    logger.info("")
    logger.info("DRY RUN. Nothing was changed.")
    logger.info("Re-run with COMPLETE_STUCK_ORDERS_APPLY=1 to complete these orders.")
    return
  }

  let done = 0
  for (const r of rows) {
    try {
      await completeOrderWorkflow(container).run({ input: { orderIds: [r.id] } })
      logger.info(`Completed order #${r.display_id} (${r.id})`)
      done++
    } catch (e) {
      // Keep going: one bad order must not block the others, and the run is
      // idempotent so a retry is always safe.
      logger.error(`Failed to complete #${r.display_id} (${r.id}): ${(e as Error).message}`)
    }
  }

  logger.info(`Done. Completed ${done}/${rows.length} order(s).`)

  // Confirm from the database rather than trusting the workflow's return.
  const { rows: after } = await knex.raw(
    `SELECT display_id, status FROM "order" WHERE id = ANY(?) ORDER BY display_id`,
    [rows.map((r: { id: string }) => r.id)]
  )
  for (const a of after) {
    logger.info(`  verify #${a.display_id} -> ${a.status}`)
  }

  void Modules
}
