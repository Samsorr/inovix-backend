jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createStep: (_name: string, fn: any) => fn,
  StepResponse: class {
    constructor(public output: any) {}
  },
}))

jest.mock("@medusajs/framework/utils", () => ({
  Modules: { ORDER: "order", FULFILLMENT: "fulfillment", INVENTORY: "inventory" },
  ContainerRegistrationKeys: { LINK: "link", QUERY: "query", LOGGER: "logger" },
}))

import registerOrderFulfillment from "../steps/register-order-fulfillment"

function makeContainer(reservations: any[]) {
  const link = { create: jest.fn(async () => undefined) }
  const order = { registerFulfillment: jest.fn(async () => undefined) }
  const query = { graph: jest.fn(async () => ({ data: reservations })) }
  const inventory = {
    adjustInventory: jest.fn(async () => undefined),
    deleteReservationItems: jest.fn(async () => undefined),
  }
  const logger = { error: jest.fn(), info: jest.fn() }
  const services: Record<string, any> = { link, order, query, inventory, logger }
  const container = { resolve: (k: string) => services[k] }
  return { container, link, order, query, inventory, logger }
}

const input = {
  order_id: "order_1",
  fulfillment_id: "ful_1",
  items: [{ id: "li_1", quantity: 2 }],
}

describe("register-order-fulfillment step", () => {
  it("links the fulfillment to the order and registers it", async () => {
    const { container, link, order } = makeContainer([])
    await registerOrderFulfillment(input as any, { container } as any)
    expect(link.create).toHaveBeenCalledWith([
      { order: { order_id: "order_1" }, fulfillment: { fulfillment_id: "ful_1" } },
    ])
    expect(order.registerFulfillment).toHaveBeenCalledWith({
      order_id: "order_1",
      items: [{ id: "li_1", quantity: 2 }],
    })
  })

  it("releases the reservation and decrements stock for managed items", async () => {
    const reservations = [
      { id: "resitem_1", inventory_item_id: "iitem_1", location_id: "loc_1", quantity: 2 },
    ]
    const { container, inventory } = makeContainer(reservations)
    await registerOrderFulfillment(input as any, { container } as any)
    // adjust (negative) BEFORE delete so a partial failure is fail-safe (too low, not overselling).
    expect(inventory.adjustInventory).toHaveBeenCalledWith([
      { inventoryItemId: "iitem_1", locationId: "loc_1", adjustment: -2 },
    ])
    expect(inventory.deleteReservationItems).toHaveBeenCalledWith(["resitem_1"])
    expect(inventory.adjustInventory.mock.invocationCallOrder[0]).toBeLessThan(
      inventory.deleteReservationItems.mock.invocationCallOrder[0]
    )
  })

  it("reads a bigNumber reservation quantity instead of writing NaN", async () => {
    // query.graph serves bigNumber columns as raw { value, precision } objects;
    // -Number(that) is -NaN, which either throws inside the best-effort catch
    // (stock drift, logged only) or writes garbage into inventory.
    const reservations = [
      {
        id: "resitem_1",
        inventory_item_id: "iitem_1",
        location_id: "loc_1",
        quantity: { value: "2", precision: 20 },
      },
    ]
    const { container, inventory } = makeContainer(reservations)
    await registerOrderFulfillment(input as any, { container } as any)
    expect(inventory.adjustInventory).toHaveBeenCalledWith([
      { inventoryItemId: "iitem_1", locationId: "loc_1", adjustment: -2 },
    ])
  })

  it("leaves a reservation with an unreadable quantity alone and logs it", async () => {
    const reservations = [
      { id: "r_bad", inventory_item_id: "i1", location_id: "l1", quantity: null },
      { id: "r_ok", inventory_item_id: "i2", location_id: "l2", quantity: 1 },
    ]
    const { container, inventory, logger } = makeContainer(reservations)
    await registerOrderFulfillment(input as any, { container } as any)
    expect(inventory.adjustInventory).toHaveBeenCalledWith([
      { inventoryItemId: "i2", locationId: "l2", adjustment: -1 },
    ])
    expect(inventory.deleteReservationItems).toHaveBeenCalledWith(["r_ok"])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("r_bad"))
  })

  it("skips inventory when there are no reservations (unmanaged variant)", async () => {
    const { container, inventory } = makeContainer([])
    await registerOrderFulfillment(input as any, { container } as any)
    expect(inventory.adjustInventory).not.toHaveBeenCalled()
    expect(inventory.deleteReservationItems).not.toHaveBeenCalled()
  })

  it("does not throw (and logs) if the inventory adjustment fails", async () => {
    const reservations = [
      { id: "r1", inventory_item_id: "i1", location_id: "l1", quantity: 1 },
    ]
    const { container, inventory, logger } = makeContainer(reservations)
    inventory.adjustInventory.mockRejectedValueOnce(new Error("boom"))
    await expect(
      registerOrderFulfillment(input as any, { container } as any)
    ).resolves.toBeDefined()
    expect(logger.error).toHaveBeenCalled()
  })
})
