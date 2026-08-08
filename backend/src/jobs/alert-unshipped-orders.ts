import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { INotificationModuleService, Logger } from "@medusajs/framework/types"

import { EmailTemplates } from "../modules/email-notifications/templates"
import { Sentry } from "../lib/instrument"
import {
  buildVerzendstationQueues,
  QUEUE_ORDER_FIELDS,
  selectStaleUnshipped,
  type AttentionEntry,
  type QueueEntry,
  type QueueOrderRow,
} from "../lib/verzendstation-queues"

// Orders whose DHL label was made this long ago without a "markeer als
// verzonden" click get flagged to the operator. Without that click the
// customer never receives the track-and-trace mail.
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function formatDutchDate(iso: string | null): string {
  if (!iso) return "onbekend"
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return "onbekend"
  return t.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })
}

// Pure mapping from stale queue entries + attention rows to the notification
// payload. Exported for unit tests.
//
// The attention rows are the orders buildVerzendstationQueues used to drop
// silently (missing capture row, refund after the label, native "Fulfill
// items" fulfillment). They ride along in this daily mail on purpose: it is
// one of only three surfaces the operator watches, and it used to go blind on
// exactly the same rows as the other two.
//
// They are rendered through the existing template's three string fields
// (display_id / customer_name / packed_at) rather than a new template, because
// src/modules/email-notifications/** is owned elsewhere right now. The row
// still reads unambiguously; a dedicated section in the template is the
// follow-up.
export function buildAlertPayload(
  stale: QueueEntry[],
  todayIso: string,
  attention: AttentionEntry[] = []
) {
  const subject =
    stale.length > 0 && attention.length > 0
      ? `Let op: ${stale.length} ingepakte bestelling(en) nog niet verzonden, ${attention.length} met een probleem`
      : attention.length > 0
        ? `Let op: ${attention.length} bestelling(en) hebben aandacht nodig`
        : `Let op: ${stale.length} ingepakte bestelling(en) nog niet verzonden`

  return {
    idempotency_key: `unshipped-orders-alert-${todayIso}`,
    data: {
      emailOptions: { subject },
      orders: [
        ...stale.map((e) => ({
          display_id: e.display_id != null ? String(e.display_id) : "?",
          customer_name: e.customer_name || "Onbekende klant",
          packed_at: formatDutchDate(e.packed_at),
        })),
        ...attention.map((e) => ({
          display_id: e.display_id != null ? String(e.display_id) : "?",
          customer_name: `${e.customer_name || "Onbekende klant"} | AANDACHT NODIG: ${e.reasons
            .map((r) => r.label)
            .join(" + ")}`,
          packed_at: e.packed_at
            ? formatDutchDate(e.packed_at)
            : `n.v.t. (besteld ${formatDutchDate(e.created_at)})`,
        })),
      ],
    },
  }
}

// Daily 07:00 safety net: any order with a label made >24h ago that was never
// marked shipped, plus any order the queue could not clear (missing capture
// row, refund after the label, native "Fulfill items" fulfillment), gets ONE
// summary email to the operator. The per-day idempotency key makes reruns
// harmless.
export default async function alertUnshippedOrders(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger

  // Everything is wrapped: this job is the last line of defence against a
  // forgotten parcel, so a data quirk or a mail hiccup must degrade to "no
  // alert this run" (logged + reported) instead of throwing silently forever.
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const notifications = container.resolve(
      Modules.NOTIFICATION
    ) as INotificationModuleService

    // The Verzendstation queue page only shows the newest 200 orders; this
    // safety net must look further back so an order that scrolled off the
    // visible page doesn't silently skip the unshipped alert.
    const { data } = await query.graph({
      entity: "order",
      fields: QUEUE_ORDER_FIELDS,
      pagination: { take: 1000, skip: 0, order: { created_at: "DESC" } },
    })

    const queues = buildVerzendstationQueues((data ?? []) as QueueOrderRow[], {
      // One malformed order out of 1000 must not cost every other order its
      // alert; log it by id so it can be fixed.
      onSkip: (orderId, err) =>
        logger.warn(
          `[alert-unshipped-orders] skipped order ${orderId}: ${(err as Error)?.message}`
        ),
    })
    const stale = selectStaleUnshipped(queues, Date.now(), MAX_AGE_MS)
    // No age threshold on the attention rows: reconcile-broker-payments closes
    // a genuine callback window within five minutes, so anything still
    // drifting at 07:00 is real drift and the operator has to know today.
    const attention = queues.needs_attention
    if (stale.length === 0 && attention.length === 0) {
      return
    }

    if (attention.length > 0) {
      // Second channel for the same fact: the Sentry ops feed reaches the
      // operator's Telegram even if this mail bounces.
      const summary = attention
        .map((e) => `#${e.display_id ?? "?"}: ${e.reasons.map((r) => r.code).join("+")}`)
        .join(", ")
      logger.error(
        `[alert-unshipped-orders] ${attention.length} order(s) need attention: ${summary}`
      )
      Sentry.captureMessage(
        `Verzendstation: ${attention.length} order(s) need attention (${summary})`,
        { level: "warning", tags: { job: "alert-unshipped-orders" } }
      )
    }

    const to =
      process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL || "info@inovix.nl"
    const today = new Date().toISOString().slice(0, 10)
    const payload = buildAlertPayload(stale, today, attention)

    await notifications.createNotifications({
      to,
      channel: "email",
      template: EmailTemplates.UNSHIPPED_ORDERS_ALERT,
      idempotency_key: payload.idempotency_key,
      trigger_type: "job.alert-unshipped-orders",
      data: payload.data,
    })

    logger.info(
      `[alert-unshipped-orders] alerted ${to} about ${stale.length} unshipped order(s) and ${attention.length} order(s) needing attention`
    )
  } catch (err) {
    logger.error(
      `[alert-unshipped-orders] run failed, no alert sent: ${(err as Error).message}`
    )
    Sentry.captureException(err, { tags: { job: "alert-unshipped-orders" } })
  }
}

export const config = {
  name: "alert-unshipped-orders",
  // daily 05:00 UTC = 07:00 Amsterdam in summer, 06:00 in winter (Railway cron runs UTC)
  schedule: "0 5 * * *",
}
