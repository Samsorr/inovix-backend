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

// A paid order whose Medusa capture row never arrived (the 2026-06-03
// broker-callback shape): Mollie has the money, `captures` is empty. Before
// the needs_attention bucket this order was invisible on every surface, this
// daily alert included.
function driftedOrder(id = "order_drift") {
  return {
    id,
    display_id: 28499,
    status: "pending",
    created_at: "2026-07-14T08:00:00.000Z",
    email: "piet@example.com",
    shipping_address: { first_name: "Piet", last_name: "Pietersen" },
    items: [{ id: "item_1", quantity: undefined, detail: { quantity: 1 } }],
    fulfillments: [],
    payment_collections: [
      {
        payments: [
          {
            provider_id: BROKER,
            amount: { value: "89.9", precision: 20 },
            raw_amount: { value: "89.9", precision: 20 },
            canceled_at: null,
            captures: [],
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

  it("adds the attention orders as their own labelled rows", () => {
    const attention = [
      {
        id: "order_drift",
        display_id: 28499,
        customer_name: "Piet Pietersen",
        item_count: 1,
        created_at: "2026-07-14T08:00:00.000Z",
        packed_at: null,
        customer_note: null,
        reasons: [
          {
            code: "payment_unconfirmed" as const,
            label: "Betaling niet bevestigd in Medusa: De betaling is nog niet (volledig) ontvangen",
            action: "Controleer de betaling.",
          },
        ],
      },
    ]

    const p = buildAlertPayload([], "2026-07-14", attention)

    expect(p.data.orders).toHaveLength(1)
    expect(p.data.orders[0].display_id).toBe("28499")
    expect(p.data.orders[0].customer_name).toContain("AANDACHT NODIG")
    expect(p.data.orders[0].customer_name).toContain("Betaling niet bevestigd")
    // No label exists, so the row must not claim a label date.
    expect(p.data.orders[0].packed_at).toContain("n.v.t.")
    expect(p.data.orders[0].packed_at).toContain("juli")
    expect(p.data.emailOptions.subject).toContain("aandacht nodig")
    // The template's own validator must still accept the payload.
    expect(
      p.data.orders.every(
        (o) =>
          typeof o.display_id === "string" &&
          typeof o.customer_name === "string" &&
          typeof o.packed_at === "string"
      )
    ).toBe(true)
  })

  it("names both counts when stale and attention orders are mixed", () => {
    const subject = buildAlertPayload(stale, "2026-07-14", [
      {
        id: "o",
        display_id: 1,
        customer_name: "X",
        item_count: 1,
        created_at: null,
        packed_at: null,
        customer_note: null,
        reasons: [{ code: "manual_fulfillment" as const, label: "L", action: "A" }],
      },
    ]).data.emailOptions.subject
    expect(subject).toContain("2 ingepakte")
    expect(subject).toContain("1 met een probleem")
  })
})

describe("alertUnshippedOrders", () => {
  it("alerts on a stale packed order", async () => {
    const { container, createNotifications } = makeContainer({ rows: [staleOrder()] })
    await alertUnshippedOrders(container)
    expect(createNotifications).toHaveBeenCalledTimes(1)
    expect(createNotifications.mock.calls[0][0].data.orders).toHaveLength(1)
  })

  it("alerts on a paid order whose capture row is missing, with no packed label at all", async () => {
    const { container, createNotifications, logger } = makeContainer({
      rows: [driftedOrder()],
    })

    await alertUnshippedOrders(container)

    expect(createNotifications).toHaveBeenCalledTimes(1)
    const rows = createNotifications.mock.calls[0][0].data.orders
    expect(rows).toHaveLength(1)
    expect(rows[0].display_id).toBe("28499")
    expect(rows[0].customer_name).toContain("AANDACHT NODIG")
    // And it is loud in the logs / Sentry ops feed, not only in an email.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("need attention"))
  })

  it("stays silent when there is nothing stale and nothing drifting", async () => {
    const healthy = {
      ...driftedOrder("order_ok"),
      payment_collections: [
        {
          payments: [
            {
              provider_id: BROKER,
              amount: { value: "89.9", precision: 20 },
              raw_amount: { value: "89.9", precision: 20 },
              canceled_at: null,
              captures: [{ amount: { value: "89.9", precision: 20 } }],
              refunds: [],
            },
          ],
        },
      ],
    }
    const { container, createNotifications } = makeContainer({ rows: [healthy] })

    await alertUnshippedOrders(container)

    expect(createNotifications).not.toHaveBeenCalled()
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
