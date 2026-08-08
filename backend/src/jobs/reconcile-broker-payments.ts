import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"

import { Sentry } from "../lib/instrument"
import { BrokerClient } from "../modules/payment-via-broker/client"
import { TELEGRAM_OPS_MODULE } from "../modules/telegram-ops"
import type TelegramOpsService from "../modules/telegram-ops/service"
import { escapeHtml, eur } from "../modules/telegram-ops/format"
import {
  BROKER_URL,
  BROKER_CLIENT_ID,
  BROKER_HMAC_SECRET,
  RELAY_BASE_URL,
  CF_KV_ACCOUNT_ID,
  CF_KV_NAMESPACE_ID,
  CF_KV_API_TOKEN,
} from "../lib/constants"

const PROVIDER_ID = "pp_via_broker_via_broker"
// Broker statuses that mean the money is in | i.e. the cart should become an
// order. Mirrors the provider's mapStatus.
const PAID_STATUSES = new Set(["authorized", "captured"])
// Only look back a few hours: a paid order is recovered within one tick of
// payment, and an unpaid pending session's Mollie payment expires well before
// this, so older sessions are abandoned carts not worth re-polling.
const LOOKBACK_MS = 3 * 60 * 60 * 1000

// How often the "paid but no order" alert repeats while the condition holds.
// The job ticks every 5 minutes and the condition persists until someone fixes
// it, so an ungated send would be 36 identical messages inside the 3h window.
// One per hour is loud enough to act on and quiet enough to keep reading.
const PAID_NO_ORDER_REPEAT_MS = 60 * 60 * 1000

type BrokerSession = {
  data?: { cart_id?: string; ref?: string } | null
  created_at?: string | Date | null
}

// ---------------------------------------------------------------------------
// "Paid but no order": the worst failure mode in the shop. Mollie captured the
// money, cart completion keeps throwing (almost always inventory), so the
// customer has paid and has nothing. Detection already existed; this is the
// delivery to the surface the operator actually watches.
//
// Deliberately NOT svc.notify(): notify claims its key BEFORE sending and never
// releases it, so one send is all you ever get and a Telegram hiccup loses it
// permanently. That is the trap this alert can least afford. Instead the
// reminder primitives (findEvent + touchEvent, same as telegram-slipping-orders)
// hold a last-sent timestamp, the row is touched AFTER the send, and it is
// deleted when the condition resolves so a later recurrence starts clean.
// ---------------------------------------------------------------------------

export function paidNoOrderKey(cartId: string): string {
  return `tg-paidnoorder-${cartId}`
}

/** True when there is no previous send, or the last one is older than the repeat window. */
export function isPaidNoOrderAlertDue(
  sentAt: Date | string | null | undefined,
  now: Date,
  repeatMs: number = PAID_NO_ORDER_REPEAT_MS
): boolean {
  if (!sentAt) return true
  const t = new Date(sentAt as string).getTime()
  if (!Number.isFinite(t)) return true
  return now.getTime() - t >= repeatMs
}

function amountLabel(amountMinor: number | null | undefined, currencyCode: string | null | undefined): string {
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return "unknown"
  const code = (currencyCode ?? "EUR").toUpperCase()
  return code === "EUR" ? eur(amountMinor / 100) : `${code} ${(amountMinor / 100).toFixed(2)}`
}

/**
 * Bot copy is English: this is operator-facing, and customer surfaces are the
 * Dutch ones. Matches the rest of the bot ("New order", "Label ready"). Ids are
 * escaped even though they are system-generated: parse mode is HTML and every
 * push in this codebase goes through the escaping helpers.
 *
 * Nothing in this text ever travels toward Mollie. It is built here and handed
 * straight to the Telegram Bot API.
 */
export function buildPaidNoOrderAlert(input: {
  cartId: string
  ref: string
  amountMinor?: number | null
  currencyCode?: string | null
}): string {
  return [
    "🚨 <b>Paid, no order</b>",
    `Amount: ${amountLabel(input.amountMinor, input.currencyCode)}`,
    `Cart: <code>${escapeHtml(input.cartId)}</code>`,
    `Payment ref: <code>${escapeHtml(input.ref)}</code>`,
    "",
    "The payment went through but creating the order keeps failing (almost always stock). So the customer has paid and has no order.",
    "",
    "<b>What to do:</b> check the stock of the items in this cart in admin and correct it. This job retries every 5 minutes and gives up 3 hours after the payment. If it still fails, create the order manually or refund via Medusa admin, and tell the customer.",
  ].join("\n")
}

export function buildPaidNoOrderResolved(input: { cartId: string; orderRef?: string | null }): string {
  return [
    "✅ <b>Resolved: paid without an order</b>",
    `Cart <code>${escapeHtml(input.cartId)}</code> now has an order${
      input.orderRef ? ` (${escapeHtml(input.orderRef)})` : ""
    }.`,
    "No further action needed.",
  ].join("\n")
}

type ReminderService = Pick<TelegramOpsService, "findEvent" | "touchEvent" | "releaseAction" | "sendToAll" | "isConfigured">

function resolveTelegram(container: MedusaContainer): ReminderService | null {
  try {
    const svc = container.resolve(TELEGRAM_OPS_MODULE) as TelegramOpsService
    return svc?.isConfigured?.() ? svc : null
  } catch {
    return null
  }
}

/**
 * Alert once, then at most once an hour while the condition holds. The Sentry
 * record shares the same gate so the two channels tell the same story at the
 * same cadence instead of the log filling with 36 copies per stuck cart. With
 * no Telegram configured the gate cannot be read, so Sentry falls back to
 * capturing every tick (the behaviour before this alert existed).
 */
async function alertPaidNoOrder(
  tg: ReminderService | null,
  input: { cartId: string; ref: string; amountMinor?: number | null; currencyCode?: string | null },
  now: Date
): Promise<void> {
  const key = paidNoOrderKey(input.cartId)
  let due = true
  if (tg) {
    try {
      const row = await tg.findEvent(key)
      due = isPaidNoOrderAlertDue(row?.sent_at, now)
    } catch {
      // Never let a state read swallow the most important alert in the system.
      due = true
    }
  }
  if (!due) return

  // Durable record first: it must not depend on Telegram being reachable.
  Sentry.captureMessage(
    `[reconcile-broker-payments] cart ${input.cartId} (ref ${input.ref}) is PAID but cart completion keeps failing | money taken, no order`,
    { level: "warning", tags: { job: "reconcile-broker-payments" } }
  )
  if (!tg) return

  try {
    await tg.sendToAll(buildPaidNoOrderAlert(input))
    // Touch AFTER the send. A crash in between costs one duplicate five minutes
    // later; touching first would cost an hour of silence.
    await tg.touchEvent(key, "payment_stuck", {
      sent_at: now,
      payload: { cart_id: input.cartId, ref: input.ref, amount_minor: input.amountMinor ?? null },
    })
  } catch (e) {
    // Notifications are advisory. Recovering the customer's order is not.
    Sentry.captureException(e, { tags: { job: "reconcile-broker-payments", step: "paid-no-order-alert" } })
  }
}

/**
 * Resolved = the cart became an order. Say so once and delete the row, so the
 * operator can stop chasing it and a future stuck cart alerts from scratch
 * instead of inheriting a stale timestamp. Silent when we never alerted.
 */
async function resolvePaidNoOrder(
  tg: ReminderService | null,
  cartId: string,
  orderRef?: string | null
): Promise<void> {
  if (!tg) return
  try {
    const key = paidNoOrderKey(cartId)
    const row = await tg.findEvent(key)
    if (!row) return
    await tg.sendToAll(buildPaidNoOrderResolved({ cartId, orderRef }))
    await tg.releaseAction(key)
  } catch (e) {
    // This runs outside the per-cart try/catch, so it must not be able to
    // abort the reconcile loop that recovers paid-but-orphaned orders.
    Sentry.captureException(e, { tags: { job: "reconcile-broker-payments", step: "paid-no-order-resolve" } })
  }
}

/**
 * Pure selection: the recent broker sessions that carry both a cart_id and a
 * ref, deduped to one entry per cart (the most recent ref, assuming the input
 * is ordered newest-first). Exported for unit testing without a live container.
 */
export function selectRecentBrokerCarts(
  sessions: BrokerSession[],
  nowMs: number,
  lookbackMs: number = LOOKBACK_MS
): Array<{ cartId: string; ref: string }> {
  const seen = new Set<string>()
  const out: Array<{ cartId: string; ref: string }> = []
  for (const s of sessions) {
    const t = s.created_at ? new Date(s.created_at).getTime() : 0
    if (!Number.isFinite(t) || nowMs - t >= lookbackMs) continue
    const cartId = s.data?.cart_id
    const ref = s.data?.ref
    if (!cartId || !ref || seen.has(cartId)) continue
    seen.add(cartId)
    out.push({ cartId, ref })
  }
  return out
}

/**
 * Safety net for the redirect-payment race: a customer can pay at Mollie and
 * then never land back on /checkout/return (closes the tab, the iDEAL app drops
 * the redirect), leaving a paid Mollie payment with no Inovix order. The
 * browser is the only thing that calls cart.complete, so without this the order
 * is lost even though the money was taken.
 *
 * Every tick this polls the broker for each recent, not-yet-completed broker
 * cart and completes only the ones the broker reports as paid. Polling first
 * (instead of letting completeCartWorkflow's authorize step reject unpaid
 * carts) keeps the logs clean | otherwise every abandoned checkout would emit
 * an "authorize payment session" error on every tick.
 *
 * completeCartWorkflow is idempotent (Medusa returns the existing order if the
 * browser already completed the cart), so this never duplicates an order or
 * races the return, and it fires the normal order-placed flow incl. the
 * confirmation email. Nothing here is sent to Mollie | the broker poll only
 * carries the opaque ref.
 */
export default async function reconcileBrokerPayments(
  container: MedusaContainer
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (m: string) => void
    warn: (m: string) => void
  }

  if (!BROKER_URL || !BROKER_CLIENT_ID || !BROKER_HMAC_SECRET) {
    logger.warn(
      "[reconcile-broker-payments] broker not configured (BROKER_URL/CLIENT_ID/HMAC_SECRET missing); skipping"
    )
    return
  }

  const paymentModule = container.resolve(Modules.PAYMENT)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const tg = resolveTelegram(container)
  const now = new Date()

  const sessions = await paymentModule.listPaymentSessions(
    { provider_id: PROVIDER_ID },
    { select: ["id", "data", "created_at"], take: 300, order: { created_at: "DESC" } }
  )

  const candidates = selectRecentBrokerCarts(
    (sessions ?? []) as BrokerSession[],
    Date.now()
  )
  if (candidates.length === 0) {
    // Idle (no recent broker checkouts): stay silent.
    return
  }

  // Drop carts that are already completed (or no longer exist).
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: ["id", "completed_at"],
    filters: { id: candidates.map((c) => c.cartId) },
  })
  const cartRows = (carts ?? []) as Array<{ id: string; completed_at: string | null } | null>
  const incomplete = new Set(
    cartRows.filter((c) => c && !c.completed_at).map((c) => c!.id)
  )
  // Only a cart we can SEE and that carries completed_at counts as resolved. A
  // cart id the graph no longer returns is not proof of an order, so its alert
  // row is left alone rather than falsely marked handled.
  const completedIds = cartRows.filter((c) => c?.completed_at).map((c) => c!.id)
  for (const cartId of completedIds) {
    await resolvePaidNoOrder(tg, cartId)
  }

  const open = candidates.filter((c) => incomplete.has(c.cartId))
  if (open.length === 0) {
    return
  }

  const broker = new BrokerClient({
    brokerUrl: BROKER_URL,
    clientId: BROKER_CLIENT_ID,
    hmacSecret: BROKER_HMAC_SECRET,
    relayBaseUrl: RELAY_BASE_URL,
    cfKvAccountId: CF_KV_ACCOUNT_ID ?? "",
    cfKvNamespaceId: CF_KV_NAMESPACE_ID ?? "",
    cfKvApiToken: CF_KV_API_TOKEN ?? "",
  })

  let reconciled = 0
  for (const { cartId, ref } of open) {
    // Poll the broker (NOT Mollie) for the live status before doing anything.
    let paid = false
    let amountMinor: number | null = null
    let currencyCode: string | null = null
    try {
      const payment = await broker.getPayment(ref)
      paid = PAID_STATUSES.has(payment.status)
      amountMinor = payment.amountMinor ?? null
      currencyCode = payment.currencyCode ?? null
    } catch (err) {
      logger.warn(
        `[reconcile-broker-payments] status poll failed for ${ref} (cart ${cartId}): ${(err as Error).message}`
      )
      continue
    }
    if (!paid) {
      continue
    }

    // Paid but no order: complete it. Idempotent, so a concurrent browser
    // return is harmless.
    try {
      const { result, errors } = await completeCartWorkflow(container).run({
        input: { id: cartId },
        throwOnError: false,
      })
      const order = result as { id?: string; display_id?: number | string } | undefined
      const orderId = order?.id
      if (!errors?.length && orderId) {
        reconciled++
        logger.info(
          `[reconcile-broker-payments] recovered paid-but-orphaned cart ${cartId} -> order ${orderId}`
        )

        // Telegram ops notification (N11): advisory only, never fails the job.
        try {
          const notifier = container.resolve(TELEGRAM_OPS_MODULE) as TelegramOpsService
          void notifier.notify(
            `tg-rescued-${cartId}`,
            "payment_rescued",
            `🛟 <b>Rescued payment</b>\nCustomer paid but never returned to the site. Order created from cart ${cartId}.`
          ).catch(() => {})
        } catch {
          /* advisory only */
        }

        // If we had been shouting about this cart, close the loop: the cart
        // that had no order now has one.
        await resolvePaidNoOrder(
          tg,
          cartId,
          order?.display_id != null ? `#${order.display_id}` : orderId
        )
      } else {
        logger.warn(
          `[reconcile-broker-payments] cart ${cartId} is paid but did not complete (likely inventory/validation); will retry next tick`
        )
        // Money has been taken but no order exists and completion is failing.
        // The 3h lookback means this warn loop goes silent on its own, so the
        // operator must hear about it while it is still actionable.
        await alertPaidNoOrder(tg, { cartId, ref, amountMinor, currencyCode }, now)
      }
    } catch (err) {
      logger.warn(
        `[reconcile-broker-payments] completion errored for cart ${cartId} (non-fatal): ${(err as Error).message}`
      )
    }
  }

  // One summary line per tick, only when there was actually work to do
  // (open.length > 0 here | the idle and all-completed cases returned early).
  // Doubles as the heartbeat that confirms the safety net is alive.
  logger.info(
    `[reconcile-broker-payments] checked ${open.length} open broker cart(s), recovered ${reconciled}`
  )
  if (reconciled > 0) {
    Sentry.captureMessage(
      `[reconcile-broker-payments] recovered ${reconciled} paid order(s) the browser return did not finalise`,
      { level: "info", tags: { job: "reconcile-broker-payments" } }
    )
  }
}

export const config = {
  name: "reconcile-broker-payments",
  // every 5 minutes
  schedule: "*/5 * * * *",
}
