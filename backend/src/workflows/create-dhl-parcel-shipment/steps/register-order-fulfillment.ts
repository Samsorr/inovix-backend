import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { asQty } from "../../../lib/item-quantity"

export type RegisterOrderFulfillmentInput = {
  order_id: string
  fulfillment_id: string
  // The order line items being fulfilled (full quantities | the DHL flow
  // always fulfils the whole order in one label).
  items: Array<{ id: string; quantity: number }>
}

/**
 * The bare fulfillment module createFulfillment (used by call-dhl) creates a
 * Fulfillment row but does NOT associate it with the order. Without this step
 * the order keeps fulfillment_status "not_fulfilled" and order.fulfillments is
 * empty, so the admin order page and our widget never see the label (and a
 * second click would buy a second label). This mirrors what Medusa's native
 * createOrderFulfillmentWorkflow does after creating the fulfillment:
 *   - createRemoteLinkStep: link Order <-> Fulfillment
 *   - registerOrderFulfillmentStep: orderModuleService.registerFulfillment
 * (packed_at is set on the fulfillment itself in call-dhl.)
 */
const registerOrderFulfillment = createStep(
  "register-dhl-order-fulfillment",
  async (input: RegisterOrderFulfillmentInput, { container }: any) => {
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const orderService = container.resolve(Modules.ORDER)

    // 1. Link first: this is what makes the fulfillment resolvable via
    //    order.fulfillments (so the widget shows it and the route's duplicate
    //    guard can find it). Do it before registerFulfillment so a failure in
    //    step 2 still leaves the label visible/attached rather than orphaned.
    await link.create([
      {
        [Modules.ORDER]: { order_id: input.order_id },
        [Modules.FULFILLMENT]: { fulfillment_id: input.fulfillment_id },
      },
    ])

    // 2. Register on the order so the items' fulfilled_quantity updates and the
    //    aggregate fulfillment_status becomes "fulfilled".
    await orderService.registerFulfillment({
      order_id: input.order_id,
      items: input.items.map((i) => ({ id: i.id, quantity: i.quantity })),
    })

    // 3. Inventory: for managed variants the goods are leaving, so decrement the
    //    stocked quantity AND release the reservation (mirrors Medusa's native
    //    adjustInventoryLevelsStep + deleteReservationsStep). Both move together
    //    so `available = stocked - reserved` stays correct. Unmanaged variants
    //    have no reservation -> skipped. Best-effort: a failure here must NOT
    //    block the (already created + linked) fulfillment, so we log loudly and
    //    continue | the stock drift is then a manual correction, not a stuck order.
    try {
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const inventoryService: any = container.resolve(Modules.INVENTORY)
      const { data: reservations } = await query.graph({
        entity: "reservation",
        fields: ["id", "inventory_item_id", "location_id", "quantity"],
        filters: { line_item_id: input.items.map((i) => i.id) },
      })
      const rs = ((reservations ?? []) as Array<{
        id: string
        inventory_item_id: string
        location_id: string
        quantity: unknown
      } | null>).filter(Boolean)

      // reservation.quantity is a bigNumber column: query.graph can serve it as
      // a raw { value, precision } object, and -Number(that) is -NaN. Resolve
      // it, and leave a reservation whose quantity cannot be read completely
      // alone (adjusting and deleting must always move together, or `available`
      // drifts) rather than writing garbage into inventory.
      const usable: Array<{ id: string; inventory_item_id: string; location_id: string; quantity: number }> = []
      for (const r of rs) {
        const quantity = asQty(r!.quantity)
        if (quantity == null) {
          const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
          logger.error(
            `[dhl-parcel] reservation ${r!.id} has an unreadable quantity ` +
              `(order ${input.order_id}); left untouched, stock may need manual correction`
          )
          continue
        }
        usable.push({
          id: r!.id,
          inventory_item_id: r!.inventory_item_id,
          location_id: r!.location_id,
          quantity,
        })
      }

      if (usable.length > 0) {
        await inventoryService.adjustInventory(
          usable.map((r) => ({
            inventoryItemId: r.inventory_item_id,
            locationId: r.location_id,
            adjustment: -r.quantity,
          }))
        )
        await inventoryService.deleteReservationItems(usable.map((r) => r.id))
      }
    } catch (err) {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
      logger.error(
        `[dhl-parcel] inventory adjustment failed for order ${input.order_id} ` +
          `(fulfillment created + linked; stocked/reservation may need manual correction): ` +
          `${(err as Error).message}`
      )
    }

    return new StepResponse({ linked: true })
  },
)

export default registerOrderFulfillment
