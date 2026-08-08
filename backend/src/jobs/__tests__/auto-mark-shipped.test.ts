import { selectAutoShipCandidates, type AutoShipOrderRow } from "../auto-mark-shipped"

function row(overrides: Partial<AutoShipOrderRow>): AutoShipOrderRow {
  return {
    id: "order_1",
    status: "pending",
    shipping_address: { postal_code: "3201 ME" },
    fulfillments: [
      {
        id: "f1",
        provider_id: "dhl-parcel_dhl-parcel",
        packed_at: "2026-07-14T15:17:59.000Z",
        shipped_at: null,
        canceled_at: null,
        data: { dhl_tracking_number: "JVGL0000000000000001" },
      },
    ],
    ...overrides,
  }
}

describe("selectAutoShipCandidates", () => {
  it("selects packed, unshipped DHL fulfillments with a tracking number", () => {
    const out = selectAutoShipCandidates([row({})])
    expect(out).toEqual([
      {
        order_id: "order_1",
        tracking_number: "JVGL0000000000000001",
        postal_code: "3201 ME",
      },
    ])
  })

  it("skips shipped, canceled, unpacked and non-DHL fulfillments", () => {
    const shipped = row({
      id: "o2",
      fulfillments: [{ ...row({}).fulfillments![0], shipped_at: "2026-07-15T08:00:00Z" }],
    })
    const canceled = row({
      id: "o3",
      fulfillments: [{ ...row({}).fulfillments![0], canceled_at: "2026-07-15T08:00:00Z" }],
    })
    const unpacked = row({
      id: "o4",
      fulfillments: [{ ...row({}).fulfillments![0], packed_at: null }],
    })
    const manual = row({
      id: "o5",
      fulfillments: [
        { id: "f", provider_id: "manual_manual", packed_at: "2026-07-14T15:00:00Z", shipped_at: null, canceled_at: null, data: {} },
      ],
    })
    const noTracking = row({
      id: "o6",
      fulfillments: [{ ...row({}).fulfillments![0], data: {} }],
    })
    const canceledOrder = row({ id: "o7", status: "canceled" })
    expect(
      selectAutoShipCandidates([shipped, canceled, unpacked, manual, noTracking, canceledOrder])
    ).toEqual([])
  })

  it("tolerates null elements in the fulfillments array", () => {
    // Live prod relation arrays contain null entries for some orders (commit
    // 9d7e9fa). One such order threw a TypeError before the per-candidate
    // try/catch, killing the whole 30-minute tracking-email cron.
    const withNull = row({
      id: "o_nulls",
      fulfillments: [null as never, row({}).fulfillments![0]],
    })
    expect(selectAutoShipCandidates([withNull, row({ id: "o_ok" })]).map((c) => c.order_id)).toEqual([
      "o_nulls",
      "o_ok",
    ])
  })

  it("skips a row it cannot read and reports it instead of throwing", () => {
    const exploding = {
      id: "o_bad",
      get status(): string {
        throw new TypeError("Cannot read properties of null")
      },
    } as unknown as AutoShipOrderRow
    const onSkip = jest.fn()

    const out = selectAutoShipCandidates([exploding, row({ id: "o_ok" })], { onSkip })

    expect(out.map((c) => c.order_id)).toEqual(["o_ok"])
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onSkip.mock.calls[0][0]).toBe("o_bad")
  })

  it("skips a null row entirely", () => {
    expect(
      selectAutoShipCandidates([null as never, row({ id: "o_ok" })]).map((c) => c.order_id)
    ).toEqual(["o_ok"])
  })

  it("prefers the unshipped fulfillment when a shipped redo pair exists", () => {
    const pair = row({
      id: "o8",
      fulfillments: [
        { ...row({}).fulfillments![0], id: "old", canceled_at: "2026-07-14T16:00:00Z" },
        { ...row({}).fulfillments![0], id: "new", data: { dhl_tracking_number: "JVGL0000000000000002" } },
      ],
    })
    expect(selectAutoShipCandidates([pair])[0].tracking_number).toBe("JVGL0000000000000002")
  })
})
