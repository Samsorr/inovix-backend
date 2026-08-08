jest.mock("../../subscribers/_helpers/send-order-shipped", () => ({
  sendOrderShippedNotification: jest.fn().mockResolvedValue({ sent: true }),
}))
jest.mock("../auto-complete-order", () => ({
  autoCompleteOrderIfDone: jest.fn().mockResolvedValue(false),
}))

import { findShippableDhlFulfillment, markDhlOrderShipped } from "../mark-dhl-shipped"

const DHL = "dhl-parcel_dhl-parcel"

function dhlFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    provider_id: DHL,
    canceled_at: null,
    shipped_at: null,
    data: { dhl_tracking_number: "JVGL0000000000000001" },
    labels: [{ tracking_number: "JVGL0000000000000001", tracking_url: "https://t", label_url: "https://l" }],
    ...overrides,
  }
}

describe("findShippableDhlFulfillment", () => {
  it("finds the active DHL fulfillment with a tracking number", () => {
    expect(findShippableDhlFulfillment({ fulfillments: [dhlFulfillment()] })?.id).toBe("f1")
  })

  it("tolerates null elements in fulfillments and labels", () => {
    // Live prod relation arrays contain null entries for some orders (commit
    // 9d7e9fa). One such order threw a TypeError here, which took out both the
    // admin send-email route and the 30-minute auto-ship cron.
    const order = {
      fulfillments: [
        null as never,
        dhlFulfillment({ id: "f_null_label", data: {}, labels: [null as never, { tracking_number: "JVGL2" }] }),
      ],
    }
    expect(findShippableDhlFulfillment(order)?.id).toBe("f_null_label")
  })

  it("skips canceled fulfillments and ones without tracking", () => {
    const canceled = dhlFulfillment({ id: "f_cancel", canceled_at: "2026-07-14T10:00:00.000Z" })
    const noTracking = dhlFulfillment({ id: "f_bare", data: {}, labels: [] })
    expect(findShippableDhlFulfillment({ fulfillments: [canceled, noTracking] })).toBeNull()
  })

  it("returns null for an empty or missing fulfillments array", () => {
    expect(findShippableDhlFulfillment({ fulfillments: [] })).toBeNull()
    expect(findShippableDhlFulfillment({})).toBeNull()
  })
})

describe("markDhlOrderShipped", () => {
  function makeContainer(order: unknown) {
    const graph = jest.fn().mockResolvedValue({ data: order ? [order] : [] })
    const updateFulfillment = jest.fn().mockResolvedValue({})
    const registerShipment = jest.fn().mockResolvedValue({})
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const container: any = {
      resolve: (key: string) => {
        if (key === "query") return { graph }
        if (key === "order") return { registerShipment }
        if (key === "fulfillment") return { updateFulfillment }
        if (key === "logger") return logger
        throw new Error(`unexpected resolve: ${key}`)
      },
    }
    return { container, updateFulfillment, registerShipment, logger }
  }

  it("ships an order whose items array contains a null element", async () => {
    const { container, updateFulfillment, registerShipment } = makeContainer({
      id: "order_1",
      email: "jan@example.com",
      items: [
        null,
        { id: "item_1", detail: { fulfilled_quantity: 2, shipped_quantity: 0 } },
      ],
      fulfillments: [dhlFulfillment()],
    })

    const result = await markDhlOrderShipped(container, "order_1")

    expect(result).toMatchObject({ ok: true, fulfillment_id: "f1", already_shipped: false })
    expect(updateFulfillment).toHaveBeenCalledTimes(1)
    expect(registerShipment).toHaveBeenCalledWith({
      order_id: "order_1",
      items: [{ id: "item_1", quantity: 2 }],
    })
  })

  it("reports no_dhl_label instead of throwing on an all-null fulfillments array", async () => {
    const { container } = makeContainer({
      id: "order_1",
      items: [],
      fulfillments: [null],
    })
    expect(await markDhlOrderShipped(container, "order_1")).toEqual({
      ok: false,
      reason: "no_dhl_label",
    })
  })
})
