// Mark an order's DHL fulfillment as shipped and send the tracking email.
// Extracted from the admin dhl-label/send-email route so the
// auto-mark-shipped job can run the exact same flow when DHL scans a parcel.
// The email helper is idempotency-keyed, so route + job can both fire
// without the customer ever receiving a duplicate mail.

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { toAmount } from "../admin/widgets/order-payment-broker.logic"
import { autoCompleteOrderIfDone } from "./auto-complete-order"
import { sendOrderShippedNotification } from "../subscribers/_helpers/send-order-shipped"

const ORDER_FIELDS = [
  "id",
  "email",
  "items.id",
  "items.detail.fulfilled_quantity",
  "items.detail.shipped_quantity",
  "fulfillments.id",
  "fulfillments.provider_id",
  "fulfillments.canceled_at",
  "fulfillments.shipped_at",
  "fulfillments.data",
  "fulfillments.labels.tracking_number",
  "fulfillments.labels.tracking_url",
  "fulfillments.labels.label_url",
]

// Flat shape (no discriminated union): this repo's tsconfig runs without
// strict mode, which breaks negative-branch union narrowing.
export type MarkDhlShippedResult = {
  ok: boolean
  fulfillment_id?: string
  already_shipped?: boolean
  reason?: "order_not_found" | "no_dhl_label"
  /** Whether the tracking email actually went out on this call. */
  email_sent?: boolean
  /** Why it did not, when it did not. */
  email_reason?: string
}

type LoggerLike = {
  info: (m: string) => void
  warn: (m: string) => void
}

// Find the active DHL fulfillment with a tracking number on a loaded order.
// Live query.graph relation arrays can contain null elements (commit 9d7e9fa),
// on both fulfillments and labels, so every element is filtered before use.
export function findShippableDhlFulfillment(order: {
  fulfillments?: Array<Record<string, any> | null> | null
}): Record<string, any> | null {
  const fulfillments = ((order.fulfillments ?? []) as any[]).filter(Boolean)
  return (
    fulfillments.find((f: any) => {
      if (f.canceled_at) return false
      const trackingFromData = typeof f.data?.dhl_tracking_number === "string"
      const trackingFromLabel = ((f.labels ?? []) as any[])
        .filter(Boolean)
        .some((l: any) => l.tracking_number != null && l.tracking_number !== "")
      const isDhl = f.provider_id === "dhl-parcel_dhl-parcel" || trackingFromData
      return isDhl && (trackingFromData || trackingFromLabel)
    }) ?? null
  )
}

// Idempotent: sets shipped_at + registers the shipment (once) and sends the
// tracking email (deduped in the helper).
//
// Calling it again on an already-shipped order does NOT resend the email by
// itself | the shared idempotency key makes the notification module skip it.
// The operator's "Verzendmail opnieuw sturen" button must pass
// `{ resend: true }`, which switches the helper to a unique key and produces a
// real second send. Automatic callers (the auto-mark-shipped cron) must NOT
// pass it, or every 30-minute tick would mail the customer again.
export async function markDhlOrderShipped(
  container: MedusaContainer,
  orderId: string,
  opts?: { resend?: boolean }
): Promise<MarkDhlShippedResult> {
  const logger = container.resolve("logger") as LoggerLike
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const orderService: any = container.resolve(Modules.ORDER)
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)

  const { data: orders } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: ORDER_FIELDS,
  })
  const order = orders?.[0]
  if (!order) return { ok: false, reason: "order_not_found" }

  const dhlFulfillment = findShippableDhlFulfillment(order)
  if (!dhlFulfillment) return { ok: false, reason: "no_dhl_label" }

  const alreadyShipped = Boolean(dhlFulfillment.shipped_at)

  // Mark shipped (best-effort: a failure here should not block the email;
  // the operator can still mark shipped natively).
  if (!alreadyShipped) {
    try {
      await fulfillmentService.updateFulfillment(dhlFulfillment.id, {
        shipped_at: new Date(),
      })
      const shipItems = ((order.items ?? []) as any[])
        .filter(Boolean)
        .map((i: any) => ({
          id: i.id,
          // Raw query.graph serves these as BigNumber objects; Number() would
          // be NaN and silently skip registerShipment for every item.
          quantity:
            toAmount(i.detail?.fulfilled_quantity) -
            toAmount(i.detail?.shipped_quantity),
        }))
        .filter((i: any) => i.quantity > 0)
      if (shipItems.length > 0) {
        await orderService.registerShipment({ order_id: orderId, items: shipItems })
      }
      logger.info(`mark-dhl-shipped: marked order ${orderId} as shipped`)
    } catch (err) {
      logger.warn(
        `mark-dhl-shipped: could not mark order ${orderId} shipped (continuing to email): ${(err as Error).message}`
      )
    }
  }

  // Idempotency-keyed: never double-sends, whichever path fires first. The
  // order id is passed so the helper never has to resolve the cross-module
  // link itself. `forceResend` is the deliberate operator override.
  const emailResult = await sendOrderShippedNotification(
    container,
    dhlFulfillment.id,
    { orderId, forceResend: opts?.resend === true }
  )

  // Close the order lifecycle once everything is done (captured + shipped);
  // Medusa never advances order.status past "pending" on its own. Guarded
  // inside the helper and never throws. Also runs on the already-shipped
  // (resend-email) path so pre-feature orders get closed too.
  await autoCompleteOrderIfDone(container, orderId, "mark-dhl-shipped")

  return {
    ok: true,
    fulfillment_id: dhlFulfillment.id,
    already_shipped: alreadyShipped,
    email_sent: emailResult?.sent === true,
    ...(emailResult?.reason ? { email_reason: emailResult.reason } : {}),
  }
}
