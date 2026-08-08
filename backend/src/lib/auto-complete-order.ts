// Auto-complete an order once it is fully captured and fully shipped, so the
// admin order list stops showing "Pending" for orders that are actually done.
// Order status is an operator lifecycle field Medusa never advances on its
// own; this closes it automatically when nothing is left to do.
//
// Called from markDhlOrderShipped (the shared mark-shipped core: admin route,
// Telegram bot, auto-mark-shipped cron) and from the shipment.created
// subscriber (Medusa's native mark-shipped, which markDhlOrderShipped does
// not go through). Best-effort: it must never break a ship flow.

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { completeOrderWorkflow } from "@medusajs/medusa/core-flows"

import {
  evaluatePaymentGate,
  hasOverride,
  parseChecklist,
} from "../admin/widgets/order-fulfillment-checklist.logic"
import {
  normalizeBrokerPayment,
} from "../admin/widgets/order-payment-broker.logic"
import { firstQty, itemQuantity, ITEM_QUANTITY_FIELDS } from "./item-quantity"
import { Sentry } from "./instrument"

const BROKER_PROVIDER_ID = "pp_via_broker_via_broker"

export const AUTO_COMPLETE_ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "metadata",
  "items.id",
  // items.quantity is unreliable through query.graph on live data (can come
  // back undefined); request all four shapes (lib/item-quantity.ts) and
  // resolve with itemQuantity.
  ...ITEM_QUANTITY_FIELDS,
  "items.detail.shipped_quantity",
  "items.detail.raw_shipped_quantity",
  "fulfillments.id",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  // Payment has no captured_amount/refunded_amount through query.graph; the
  // real amounts are the capture/refund rows, summed by normalizeBrokerPayment.
  "payment_collections.payments.provider_id",
  "payment_collections.payments.amount",
  "payment_collections.payments.raw_amount",
  "payment_collections.payments.canceled_at",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.refunds.amount",
]

export type AutoCompleteOrderRow = {
  id: string
  status?: string | null
  metadata?: Record<string, unknown> | null
  items?: Array<{
    id: string
    quantity?: unknown
    raw_quantity?: unknown
    detail?: {
      quantity?: unknown
      raw_quantity?: unknown
      shipped_quantity?: unknown
      raw_shipped_quantity?: unknown
    } | null
  } | null> | null
  fulfillments?: Array<{
    id: string
    shipped_at?: string | Date | null
    canceled_at?: string | Date | null
  } | null> | null
  payment_collections?: Array<{
    payments?: Array<{
      provider_id?: string | null
      amount?: unknown
      raw_amount?: unknown
      canceled_at?: string | Date | null
      captures?: Array<{ amount?: unknown }> | null
      refunds?: Array<{ amount?: unknown }> | null
    } | null> | null
  } | null> | null
}

// Pure guard: only a pending order whose every non-canceled fulfillment is
// shipped, every item fully shipped, and whose broker payment is fully
// captured with zero refunds (or carries a logged payment override, e.g. a
// manual bank transfer) may be auto-completed.
export function shouldAutoComplete(row: AutoCompleteOrderRow): boolean {
  if (row.status !== "pending") return false

  // query.graph relation arrays can contain null elements on live data.
  const active = (row.fulfillments ?? [])
    .filter(Boolean)
    .filter((f) => !f!.canceled_at)
  if (active.length === 0) return false
  if (!active.every((f) => f!.shipped_at)) return false

  for (const item of (row.items ?? []).filter(Boolean)) {
    const qty = itemQuantity(item)
    // Unresolvable quantity: fall back to the fulfillment check above rather
    // than blocking completion forever on a data quirk.
    if (qty == null) continue
    const shipped =
      firstQty(item!.detail?.shipped_quantity, item!.detail?.raw_shipped_quantity) ?? 0
    if (shipped + 0.005 < qty) return false
  }

  const payment = (row.payment_collections ?? [])
    .filter(Boolean)
    .flatMap((c) => c!.payments ?? [])
    .filter(Boolean)
    .find((p) => p!.provider_id === BROKER_PROVIDER_ID)
  return (
    evaluatePaymentGate(
      payment ? normalizeBrokerPayment(payment as never) : null
    ).ok || hasOverride(parseChecklist(row.metadata), "payment")
  )
}

// Load the order, apply the guard, complete. Idempotent (a completed order
// fails the status guard) and never throws.
export async function autoCompleteOrderIfDone(
  container: MedusaContainer,
  orderId: string,
  source: string
): Promise<boolean> {
  const logger = container.resolve("logger") as {
    info: (m: string) => void
    warn: (m: string) => void
  }
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: orders } = await query.graph({
      entity: "order",
      filters: { id: orderId },
      fields: AUTO_COMPLETE_ORDER_FIELDS,
    })
    const order = orders?.[0] as AutoCompleteOrderRow | undefined
    if (!order || !shouldAutoComplete(order)) return false

    await completeOrderWorkflow(container).run({ input: { orderIds: [orderId] } })
    logger.info(`auto-complete-order: completed order ${orderId} (${source})`)
    return true
  } catch (err) {
    logger.warn(
      `auto-complete-order: failed for order ${orderId} (${source}): ${(err as Error).message}`
    )
    Sentry.captureException(err, {
      tags: { helper: "auto-complete-order" },
      extra: { orderId, source },
    })
    return false
  }
}
