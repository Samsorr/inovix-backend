import { findDhlFulfillmentId } from "../../../../../lib/mark-dhl-shipped"
import {
  composeOrderPlacedEmail,
  composeOrderShippedEmail,
  type ComposedEmail,
} from "../../../../../lib/order-email-compose"
import { EmailTemplates } from "../../../../../modules/email-notifications/templates"

// Shared by the draft, preview and send routes so all three resolve the same
// payload for the same order. Not named `route.ts`, so Medusa's file router
// ignores it (same trick as picklist/build-html.ts).
//
// This is deliberately the ONLY place that turns "order id + template" into a
// composed email: if the preview resolved a different fulfillment than the send
// path, the operator would proofread one parcel's mail and send another's.

type ContainerLike = { resolve: (key: string) => any }

/**
 * Build the composed payload for one order and template, or null when this
 * email cannot be composed for this order (no address, no tracked label, no
 * DHL fulfillment, unknown template).
 *
 * `fulfillmentId` is optional for order-shipped: without it the order's single
 * active DHL fulfillment is resolved exactly the way markDhlOrderShipped does.
 */
export async function composeForTemplate(
  container: ContainerLike,
  orderId: string,
  template: string,
  fulfillmentId?: string
): Promise<ComposedEmail | null> {
  if (template === EmailTemplates.ORDER_SHIPPED) {
    const id = fulfillmentId ?? (await findDhlFulfillmentId(container as any, orderId))
    if (!id) return null
    // requireTracking stays at its default (true): offering the operator a
    // tracking mail with no tracking link to edit is worse than refusing.
    return composeOrderShippedEmail(container, id, { orderId })
  }

  if (template === EmailTemplates.ORDER_PLACED) {
    return composeOrderPlacedEmail(container, orderId)
  }

  return null
}
