import {
  buildVerzendstationQueues,
  QUEUE_ORDER_FIELDS,
  selectStaleUnshipped,
  type QueueOrderRow,
} from "../verzendstation-queues"

const BROKER = "pp_via_broker_via_broker"

function paidPayment() {
  return {
    payments: [
      // The real query.graph shape: bigNumber raw amounts + capture rows
      // (payment has no captured_amount/refunded_amount fields).
      {
        provider_id: BROKER,
        amount: { value: "100", precision: 20 },
        canceled_at: null,
        captures: [{ amount: { value: "100", precision: 20 } }],
        refunds: [],
      },
    ],
  }
}

function row(overrides: Partial<QueueOrderRow>): QueueOrderRow {
  return {
    id: "order_1",
    display_id: 28411,
    status: "pending",
    created_at: "2026-07-14T08:00:00.000Z",
    email: "jan@example.com",
    shipping_address: { first_name: "Jan", last_name: "Jansen" },
    items: [
      { id: "item_1", quantity: 2 },
      { id: "item_2", quantity: 1 },
    ],
    fulfillments: [],
    payment_collections: [paidPayment()],
    ...overrides,
  }
}

describe("buildVerzendstationQueues", () => {
  it("puts a paid, unfulfilled order in to_process with name and item count", () => {
    const q = buildVerzendstationQueues([row({})])
    expect(q.to_process).toHaveLength(1)
    expect(q.to_ship).toHaveLength(0)
    expect(q.to_process[0]).toMatchObject({
      id: "order_1",
      display_id: 28411,
      customer_name: "Jan Jansen",
      item_count: 3,
    })
  })

  it("excludes unpaid, refunded and canceled orders from to_process", () => {
    const unpaid = row({
      id: "o2",
      payment_collections: [
        { payments: [{ provider_id: BROKER, amount: 100, canceled_at: null, captures: [], refunds: [] }] },
      ],
    })
    const refunded = row({
      id: "o3",
      payment_collections: [
        { payments: [{ provider_id: BROKER, amount: 100, canceled_at: null, captures: [{ amount: 100 }], refunds: [{ amount: 100 }] }] },
      ],
    })
    const canceled = row({ id: "o4", status: "canceled" })
    const noPayment = row({ id: "o5", payment_collections: [] })
    const q = buildVerzendstationQueues([unpaid, refunded, canceled, noPayment])
    expect(q.to_process).toHaveLength(0)
    expect(q.to_ship).toHaveLength(0)
  })

  it("puts packed-but-not-shipped orders in to_ship and drops shipped ones", () => {
    const packed = row({
      id: "o6",
      fulfillments: [{ id: "f1", packed_at: "2026-07-13T10:00:00.000Z", shipped_at: null, canceled_at: null }],
    })
    const shipped = row({
      id: "o7",
      fulfillments: [{ id: "f2", packed_at: "2026-07-13T10:00:00.000Z", shipped_at: "2026-07-13T15:00:00.000Z", canceled_at: null }],
    })
    const q = buildVerzendstationQueues([packed, shipped])
    expect(q.to_ship.map((e) => e.id)).toEqual(["o6"])
    expect(q.to_process).toHaveLength(0)
  })

  it("ignores canceled fulfillments (a redo lands back in to_process)", () => {
    const redo = row({
      id: "o8",
      fulfillments: [{ id: "f3", packed_at: "2026-07-13T10:00:00.000Z", shipped_at: null, canceled_at: "2026-07-13T11:00:00.000Z" }],
    })
    const q = buildVerzendstationQueues([redo])
    expect(q.to_process.map((e) => e.id)).toEqual(["o8"])
  })

  it("sorts to_process oldest-first by created_at and to_ship oldest-first by packed_at", () => {
    const older = row({ id: "a", created_at: "2026-07-14T06:00:00.000Z" })
    const newer = row({ id: "b", created_at: "2026-07-14T09:00:00.000Z" })
    const q = buildVerzendstationQueues([newer, older])
    expect(q.to_process.map((e) => e.id)).toEqual(["a", "b"])
  })

  it("falls back to the email when the address has no name", () => {
    const q = buildVerzendstationQueues([row({ shipping_address: null })])
    expect(q.to_process[0].customer_name).toBe("jan@example.com")
  })

  it("skips a mid-flight fulfillment (exists but not packed yet)", () => {
    const midFlight = row({
      id: "o9",
      fulfillments: [{ id: "f4", packed_at: null, shipped_at: null, canceled_at: null }],
    })
    const q = buildVerzendstationQueues([midFlight])
    expect(q.to_process).toHaveLength(0)
    expect(q.to_ship).toHaveLength(0)
  })

  it("prefers the unshipped fulfillment when a shipped one also exists (redo after ship)", () => {
    const redoPacked = row({
      id: "o10",
      fulfillments: [
        { id: "f5", packed_at: "2026-07-12T10:00:00.000Z", shipped_at: "2026-07-12T15:00:00.000Z", canceled_at: null },
        { id: "f6", packed_at: "2026-07-13T09:00:00.000Z", shipped_at: null, canceled_at: null },
      ],
    })
    const q = buildVerzendstationQueues([redoPacked])
    expect(q.to_ship.map((e) => e.id)).toEqual(["o10"])
    expect(q.to_ship[0].packed_at).toBe("2026-07-13T09:00:00.000Z")
  })

  it("pulls a packed-not-shipped order out of both queues when the payment is fully refunded", () => {
    const refundedAfterPacking = row({
      id: "o12",
      fulfillments: [{ id: "f9", packed_at: "2026-07-13T10:00:00.000Z", shipped_at: null, canceled_at: null }],
      payment_collections: [
        { payments: [{ provider_id: BROKER, amount: 100, canceled_at: null, captures: [{ amount: 100 }], refunds: [{ amount: 100 }] }] },
      ],
    })
    const q = buildVerzendstationQueues([refundedAfterPacking])
    expect(q.to_ship).toHaveLength(0)
    expect(q.to_process).toHaveLength(0)
  })

  it("keeps a packed-not-shipped order in to_ship when payment is overridden (manual bank transfer)", () => {
    const overriddenPacked = row({
      id: "o13",
      fulfillments: [{ id: "f10", packed_at: "2026-07-13T10:00:00.000Z", shipped_at: null, canceled_at: null }],
      payment_collections: [],
      metadata: {
        fulfillment_checklist: {
          version: 1,
          items: {},
          package_closed: null,
          overrides: [
            {
              step: "payment",
              reason: "handmatige bankoverschrijving",
              at: "2026-07-14T09:00:00.000Z",
              by_id: "u1",
              by_name: "Anna",
            },
          ],
        },
      },
    })
    const q = buildVerzendstationQueues([overriddenPacked])
    expect(q.to_ship.map((e) => e.id)).toEqual(["o13"])
  })

  it("a canceled fulfillment next to a shipped one still counts as shipped", () => {
    const canceledPlusShipped = row({
      id: "o11",
      fulfillments: [
        { id: "f7", packed_at: "2026-07-12T10:00:00.000Z", shipped_at: null, canceled_at: "2026-07-12T11:00:00.000Z" },
        { id: "f8", packed_at: "2026-07-12T12:00:00.000Z", shipped_at: "2026-07-12T15:00:00.000Z", canceled_at: null },
      ],
    })
    const q = buildVerzendstationQueues([canceledPlusShipped])
    expect(q.to_process).toHaveLength(0)
    expect(q.to_ship).toHaveLength(0)
  })
})

describe("item_count across live query.graph quantity shapes", () => {
  it("counts the detail quantity when items.quantity comes back undefined", () => {
    // The live shape from commit bf77956: the selected items.quantity is
    // undefined and the real number only exists on items.detail. Reading a
    // single field made the warehouse queue say "0 items" for every order.
    const q = buildVerzendstationQueues([
      row({
        items: [
          { id: "item_1", quantity: undefined, detail: { quantity: 2 } },
          { id: "item_2", quantity: undefined, detail: { raw_quantity: { value: "3", precision: 20 } } },
        ],
      }),
    ])
    expect(q.to_process[0].item_count).toBe(5)
  })

  it("requests every quantity shape in QUEUE_ORDER_FIELDS", () => {
    expect(QUEUE_ORDER_FIELDS).toEqual(
      expect.arrayContaining([
        "items.quantity",
        "items.raw_quantity",
        "items.detail.quantity",
        "items.detail.raw_quantity",
      ])
    )
  })
})

describe("malformed live rows", () => {
  // Live prod relation arrays contain null elements for some orders (commit
  // 9d7e9fa). One such order used to throw a TypeError out of this pure
  // function, which 500s the whole Verzendstation page and kills the daily
  // unshipped alert for every other order too.
  it("tolerates null elements in items, fulfillments, payment_collections and payments", () => {
    const nulls = row({
      id: "o_nulls",
      items: [null as never, { id: "item_1", quantity: 2 }],
      fulfillments: [null as never],
      payment_collections: [
        null as never,
        { payments: [null as never, ...paidPayment().payments] },
      ],
    })
    const q = buildVerzendstationQueues([nulls, row({ id: "o_ok" })])
    expect(q.to_process.map((e) => e.id)).toEqual(["o_nulls", "o_ok"])
    expect(q.to_process[0].item_count).toBe(2)
  })

  it("skips a row it cannot process and reports it instead of throwing", () => {
    const exploding = {
      id: "o_bad",
      get status(): string {
        throw new TypeError("Cannot read properties of null")
      },
    } as unknown as QueueOrderRow
    const onSkip = jest.fn()

    const q = buildVerzendstationQueues([exploding, row({ id: "o_ok" })], { onSkip })

    expect(q.to_process.map((e) => e.id)).toEqual(["o_ok"])
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onSkip.mock.calls[0][0]).toBe("o_bad")
  })

  it("skips a null row entirely", () => {
    const q = buildVerzendstationQueues([null as never, row({ id: "o_ok" })])
    expect(q.to_process.map((e) => e.id)).toEqual(["o_ok"])
  })
})

describe("customer note on queue entries", () => {
  it("carries the note through to the queue entry", () => {
    const q = buildVerzendstationQueues([
      row({ metadata: { customer_note: "Graag zonder bel" } }),
    ])
    expect(q.to_process[0].customer_note).toBe("Graag zonder bel")
  })

  it("reads the legacy delivery_notes key for pre-backfill orders", () => {
    const q = buildVerzendstationQueues([row({ metadata: { delivery_notes: "oud" } })])
    expect(q.to_process[0].customer_note).toBe("oud")
  })

  it("is null when the customer left no note", () => {
    expect(buildVerzendstationQueues([row({})]).to_process[0].customer_note).toBeNull()
    const withOtherMeta = buildVerzendstationQueues([
      row({ metadata: { fulfillment_checklist: { items: {} } } }),
    ])
    expect(withOtherMeta.to_process[0].customer_note).toBeNull()
  })
})

describe("selectStaleUnshipped", () => {
  const NOW = new Date("2026-07-14T12:00:00.000Z").getTime()
  const DAY = 24 * 60 * 60 * 1000
  it("selects only to_ship entries packed more than maxAgeMs ago", () => {
    const stale = row({
      id: "old",
      fulfillments: [{ id: "f", packed_at: "2026-07-12T10:00:00.000Z", shipped_at: null, canceled_at: null }],
    })
    const fresh = row({
      id: "new",
      fulfillments: [{ id: "f", packed_at: "2026-07-14T10:00:00.000Z", shipped_at: null, canceled_at: null }],
    })
    const q = buildVerzendstationQueues([stale, fresh])
    expect(selectStaleUnshipped(q, NOW, DAY).map((e) => e.id)).toEqual(["old"])
  })
})
