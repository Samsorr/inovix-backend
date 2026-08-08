import alertUnshippedOrders, { buildAlertPayload } from "../alert-unshipped-orders"

const BROKER = "pp_via_broker_via_broker"

// A paid order packed two days ago and never marked shipped: exactly what this
// alert exists to catch.
function staleOrder(id = "order_stale") {
  return {
    id,
    display_id: 28411,
    status: "pending",
    created_at: "2026-07-10T08:00:00.000Z",
    email: "jan@example.com",
    shipping_address: { first_name: "Jan", last_name: "Jansen" },
    items: [{ id: "item_1", quantity: undefined, detail: { quantity: 2 } }],
    fulfillments: [
      { id: "f1", packed_at: "2026-07-10T10:00:00.000Z", shipped_at: null, canceled_at: null },
    ],
    payment_collections: [
      {
        payments: [
          {
            provider_id: BROKER,
            amount: { value: "100", precision: 20 },
            canceled_at: null,
            captures: [{ amount: { value: "100", precision: 20 } }],
            refunds: [],
          },
        ],
      },
    ],
  }
}

function makeContainer(opts: { rows?: unknown[]; graphError?: Error; notifyError?: Error } = {}) {
  const graph = opts.graphError
    ? jest.fn().mockRejectedValue(opts.graphError)
    : jest.fn().mockResolvedValue({ data: opts.rows ?? [] })
  const createNotifications = opts.notifyError
    ? jest.fn().mockRejectedValue(opts.notifyError)
    : jest.fn().mockResolvedValue([])
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container: any = {
    resolve: (key: string) => {
      if (key === "query") return { graph }
      if (key === "logger") return logger
      if (key === "notification") return { createNotifications }
      throw new Error(`unexpected resolve: ${key}`)
    },
  }
  return { container, graph, createNotifications, logger }
}

describe("buildAlertPayload", () => {
  const stale = [
    {
      id: "order_1",
      display_id: 28411,
      customer_name: "Jan Jansen",
      item_count: 3,
      created_at: "2026-07-12T08:00:00.000Z",
      packed_at: "2026-07-12T10:00:00.000Z",
    },
    {
      id: "order_2",
      display_id: null,
      customer_name: "",
      item_count: 1,
      created_at: null,
      packed_at: null,
    },
  ]

  it("maps entries to template rows with Dutch dates and safe fallbacks", () => {
    const p = buildAlertPayload(stale, "2026-07-14")
    expect(p.idempotency_key).toBe("unshipped-orders-alert-2026-07-14")
    expect(p.data.orders[0]).toEqual({
      display_id: "28411",
      customer_name: "Jan Jansen",
      packed_at: expect.stringContaining("juli"),
    })
    expect(p.data.orders[1].display_id).toBe("?")
    expect(p.data.orders[1].customer_name).toBe("Onbekende klant")
  })

  it("subject counts the orders", () => {
    expect(buildAlertPayload(stale, "2026-07-14").data.emailOptions.subject).toContain("2")
  })
})

describe("alertUnshippedOrders", () => {
  it("alerts on a stale packed order", async () => {
    const { container, createNotifications } = makeContainer({ rows: [staleOrder()] })
    await alertUnshippedOrders(container)
    expect(createNotifications).toHaveBeenCalledTimes(1)
    expect(createNotifications.mock.calls[0][0].data.orders).toHaveLength(1)
  })

  it("still alerts when one malformed order sits in the batch", async () => {
    // Live rows can be malformed (null relation elements, commit 9d7e9fa). One
    // bad row used to throw out of the job, so NO alert went out at all | the
    // exact silent miss this job exists to prevent.
    const exploding = {
      id: "order_bad",
      get status(): string {
        throw new TypeError("Cannot read properties of null")
      },
    }
    const { container, createNotifications, logger } = makeContainer({
      rows: [exploding, staleOrder()],
    })

    await alertUnshippedOrders(container)

    expect(createNotifications).toHaveBeenCalledTimes(1)
    expect(createNotifications.mock.calls[0][0].data.orders).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("order_bad"))
  })

  it("never throws when the order query fails", async () => {
    const { container, logger } = makeContainer({ graphError: new Error("db down") })
    await expect(alertUnshippedOrders(container)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("db down"))
  })

  it("never throws when sending the notification fails", async () => {
    const { container, logger } = makeContainer({
      rows: [staleOrder()],
      notifyError: new Error("resend 500"),
    })
    await expect(alertUnshippedOrders(container)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("resend 500"))
  })
})
