import {
  allItemsTicked,
  applyChecklistAction,
  deriveStepStates,
  emptyChecklist,
  evaluatePaymentGate,
  hasOverride,
  hasUnpackedNativeFulfillment,
  labelFailureFromResponse,
  parseChecklist,
  paymentViewGate,
} from "../order-fulfillment-checklist.logic"

const actor = { by_id: "user_1", by_name: "Anna Test" }
const NOW = "2026-07-14T10:00:00.000Z"

describe("parseChecklist", () => {
  it("returns the empty state for missing or malformed metadata", () => {
    expect(parseChecklist(null)).toEqual(emptyChecklist())
    expect(parseChecklist({})).toEqual(emptyChecklist())
    expect(parseChecklist({ fulfillment_checklist: "garbage" })).toEqual(emptyChecklist())
    expect(parseChecklist({ fulfillment_checklist: { items: [1, 2] } }).items).toEqual({})
  })

  it("round-trips a valid state and drops malformed entries", () => {
    const state = {
      version: 1,
      items: { item_1: { at: NOW, ...actor }, broken: { nope: true } },
      package_closed: { at: NOW, ...actor },
      overrides: [
        { step: "items", reason: "spoedlevering", at: NOW, ...actor },
        { step: "bogus", reason: "x" },
      ],
    }
    const parsed = parseChecklist({ fulfillment_checklist: state })
    expect(Object.keys(parsed.items)).toEqual(["item_1"])
    expect(parsed.package_closed?.by_name).toBe("Anna Test")
    expect(parsed.overrides).toHaveLength(1)
    expect(parsed.overrides[0].step).toBe("items")
  })
})

describe("applyChecklistAction", () => {
  it("ticks and unticks an item with an actor stamp", () => {
    const r1 = applyChecklistAction(
      emptyChecklist(),
      { action: "tick_item", item_id: "item_1", checked: true },
      actor,
      NOW
    )
    if ("error" in r1) throw new Error(r1.error)
    expect(r1.next.items.item_1).toEqual({ at: NOW, ...actor })

    const r2 = applyChecklistAction(
      r1.next,
      { action: "tick_item", item_id: "item_1", checked: false },
      actor,
      NOW
    )
    if ("error" in r2) throw new Error(r2.error)
    expect(r2.next.items.item_1).toBeUndefined()
  })

  it("rejects a tick without item_id", () => {
    const r = applyChecklistAction(
      emptyChecklist(),
      { action: "tick_item", item_id: "", checked: true },
      actor,
      NOW
    )
    expect("error" in r).toBe(true)
  })

  it("sets and clears package_closed", () => {
    const r1 = applyChecklistAction(
      emptyChecklist(),
      { action: "package_closed", checked: true },
      actor,
      NOW
    )
    if ("error" in r1) throw new Error(r1.error)
    expect(r1.next.package_closed?.at).toBe(NOW)
    const r2 = applyChecklistAction(
      r1.next,
      { action: "package_closed", checked: false },
      actor,
      NOW
    )
    if ("error" in r2) throw new Error(r2.error)
    expect(r2.next.package_closed).toBeNull()
  })

  it("appends an override with a >= 10 char reason and rejects short reasons", () => {
    const short = applyChecklistAction(
      emptyChecklist(),
      { action: "override", step: "items", reason: "te kort" },
      actor,
      NOW
    )
    expect("error" in short).toBe(true)

    const ok = applyChecklistAction(
      emptyChecklist(),
      { action: "override", step: "payment", reason: "handmatig betaald per bank" },
      actor,
      NOW
    )
    if ("error" in ok) throw new Error(ok.error)
    expect(ok.next.overrides).toHaveLength(1)
    expect(hasOverride(ok.next, "payment")).toBe(true)
    expect(hasOverride(ok.next, "items")).toBe(false)
  })

  it("rejects an unknown action", () => {
    const r = applyChecklistAction(emptyChecklist(), { action: "nope" } as never, actor, NOW)
    expect("error" in r).toBe(true)
  })

  it("rejects an override with an unknown step", () => {
    const r = applyChecklistAction(
      emptyChecklist(),
      { action: "override", step: "bogus" as never, reason: "een geldige lange reden" },
      actor,
      NOW
    )
    expect("error" in r).toBe(true)
  })

  it("rejects an override with a whitespace-only reason", () => {
    const r = applyChecklistAction(
      emptyChecklist(),
      { action: "override", step: "payment", reason: "            " },
      actor,
      NOW
    )
    expect("error" in r).toBe(true)
  })
})

describe("allItemsTicked", () => {
  it("is true only when every item id is ticked and there is at least one item", () => {
    const state = emptyChecklist()
    state.items = { a: { at: NOW, ...actor } }
    expect(allItemsTicked(["a"], state)).toBe(true)
    expect(allItemsTicked(["a", "b"], state)).toBe(false)
    expect(allItemsTicked([], state)).toBe(false)
  })
})

describe("evaluatePaymentGate", () => {
  const paid = { amount: 100, captured_amount: 100, refunded_amount: 0, canceled_at: null }
  it("passes a fully captured, unrefunded payment", () => {
    expect(evaluatePaymentGate(paid)).toEqual({ ok: true, reason: null })
  })
  it("blocks when no payment exists", () => {
    expect(evaluatePaymentGate(null).ok).toBe(false)
  })
  it("blocks a canceled payment", () => {
    expect(evaluatePaymentGate({ ...paid, canceled_at: NOW }).ok).toBe(false)
  })
  it("blocks any refund", () => {
    expect(evaluatePaymentGate({ ...paid, refunded_amount: 5 }).ok).toBe(false)
  })
  it("blocks a partial or missing capture", () => {
    expect(evaluatePaymentGate({ ...paid, captured_amount: 50 }).ok).toBe(false)
    expect(evaluatePaymentGate({ ...paid, captured_amount: 0 }).ok).toBe(false)
  })
  it("handles BigNumber-ish string amounts", () => {
    expect(
      evaluatePaymentGate({ amount: "100", captured_amount: "100", refunded_amount: "0" }).ok
    ).toBe(true)
  })
})

describe("paymentViewGate", () => {
  const view = {
    ref: "x", status: "captured", mollie_payment_id: null, captured_at: NOW,
    currency: "EUR", amount: 100, captured_total: 100, refunded_total: 0,
    remaining_refundable: 100, refunds: [], broker_unavailable: false,
  }
  it("passes a captured, unrefunded view", () => {
    expect(paymentViewGate(view).ok).toBe(true)
  })
  it("blocks null, refunded and under-captured views", () => {
    expect(paymentViewGate(null).ok).toBe(false)
    expect(paymentViewGate({ ...view, refunded_total: 1 }).ok).toBe(false)
    expect(paymentViewGate({ ...view, captured_total: 10 }).ok).toBe(false)
    expect(paymentViewGate({ ...view, status: "canceled" }).ok).toBe(false)
  })
})

describe("deriveStepStates", () => {
  const base = {
    paymentOk: false, paymentOverridden: false,
    itemsTicked: false, itemsOverridden: false,
    hasLabel: false, packageClosed: false, shipped: false,
  }
  it("blocks everything when payment fails", () => {
    const s = deriveStepStates(base)
    expect(s.payment).toBe("blocked")
    expect(s.pick).toBe("locked")
    expect(s.label).toBe("locked")
  })
  it("walks the happy path in order", () => {
    let s = deriveStepStates({ ...base, paymentOk: true })
    expect(s.payment).toBe("done")
    expect(s.pick).toBe("active")
    expect(s.label).toBe("locked")

    s = deriveStepStates({ ...base, paymentOk: true, itemsTicked: true })
    expect(s.label).toBe("active")

    s = deriveStepStates({ ...base, paymentOk: true, itemsTicked: true, hasLabel: true })
    expect(s.close).toBe("active")
    expect(s.ship).toBe("locked")

    s = deriveStepStates({ ...base, paymentOk: true, itemsTicked: true, hasLabel: true, packageClosed: true })
    expect(s.ship).toBe("active")
  })
  it("an override counts as done", () => {
    const s = deriveStepStates({ ...base, paymentOverridden: true, itemsOverridden: true })
    expect(s.payment).toBe("done")
    expect(s.pick).toBe("done")
    expect(s.label).toBe("active")
  })
  it("an unpaid or refunded order with a label stays blocked on payment (re-lock)", () => {
    const s = deriveStepStates({ ...base, hasLabel: true })
    expect(s.payment).toBe("blocked")
    expect(s.pick).toBe("done")
    expect(s.label).toBe("done")
    expect(s.close).toBe("locked")
  })
  it("legacy orders: a paid order with an existing label forces earlier steps done", () => {
    const s = deriveStepStates({ ...base, paymentOk: true, hasLabel: true })
    expect(s.payment).toBe("done")
    expect(s.pick).toBe("done")
    expect(s.label).toBe("done")
    expect(s.close).toBe("active")

    const shipped = deriveStepStates({ ...base, shipped: true })
    expect(shipped.ship).toBe("done")
    expect(shipped.close).toBe("done")
  })
  it("a canceled label un-ticks the package-closed step", () => {
    // The operator cancels a wrong label and opens the box again. The stored
    // package_closed tick belongs to a package that no longer exists, so step 4
    // must not stay green (and step 5 must not be offered).
    const s = deriveStepStates({
      ...base,
      paymentOk: true,
      itemsTicked: true,
      hasLabel: false,
      packageClosed: true,
    })
    expect(s.label).toBe("active")
    expect(s.close).toBe("locked")
    expect(s.ship).toBe("locked")
  })
  it("keeps close done for a shipped order even without an active label", () => {
    const s = deriveStepStates({ ...base, packageClosed: true, shipped: true })
    expect(s.close).toBe("done")
    expect(s.ship).toBe("done")
  })
  it("refund after packing re-locks close and ship", () => {
    const s = deriveStepStates({
      ...base,
      paymentOk: false,
      itemsTicked: true,
      hasLabel: true,
      packageClosed: true,
    })
    expect(s.payment).toBe("blocked")
    expect(s.close).toBe("done")
    expect(s.ship).toBe("locked")
  })
})

describe("labelFailureFromResponse", () => {
  it("keeps the cause the route computed instead of dropping it", () => {
    // The exact body the route now sends for an expired DHL key.
    const f = labelFailureFromResponse(500, {
      message:
        "De koppeling met DHL werd geweigerd (inloggegevens verlopen of ongeldig). Er is geen label gekocht. Meld dit bij de beheerder; opnieuw proberen helpt niet.",
      code: "dhl_auth",
      details: "DHL Parcel POST /labels failed with 401 after re-auth",
    })
    expect(f.message).toContain("beheerder")
    expect(f.details).toContain("401")
  })

  it("falls back to a Dutch sentence when the body carries nothing usable", () => {
    expect(labelFailureFromResponse(502, {}).message).toBe("Aanmaken mislukt (502)")
    expect(labelFailureFromResponse(502, null).details).toBeNull()
    expect(labelFailureFromResponse(500, { message: "  " }).message).toBe(
      "Aanmaken mislukt (500)"
    )
  })

  it("never renders the same sentence twice", () => {
    const f = labelFailureFromResponse(500, { message: "boom", details: "boom" })
    expect(f.details).toBeNull()
  })

  it("ignores non-string fields from an unexpected body", () => {
    const f = labelFailureFromResponse(500, { message: { nested: true }, details: 42 })
    expect(f.message).toBe("Aanmaken mislukt (500)")
    expect(f.details).toBeNull()
  })
})

describe("hasUnpackedNativeFulfillment", () => {
  it("flags the fulfillment Medusa's own 'Fulfill items' button makes", () => {
    expect(
      hasUnpackedNativeFulfillment([
        { packed_at: null, shipped_at: null, canceled_at: null },
      ])
    ).toBe(true)
  })

  it("does not flag a DHL label, a shipped or a canceled fulfillment", () => {
    // Our flow always stamps packed_at when it creates the fulfillment.
    expect(
      hasUnpackedNativeFulfillment([
        { packed_at: "2026-07-13T10:00:00.000Z", shipped_at: null, canceled_at: null },
      ])
    ).toBe(false)
    expect(
      hasUnpackedNativeFulfillment([
        { packed_at: null, shipped_at: "2026-07-13T15:00:00.000Z", canceled_at: null },
      ])
    ).toBe(false)
    expect(
      hasUnpackedNativeFulfillment([
        { packed_at: null, shipped_at: null, canceled_at: "2026-07-13T11:00:00.000Z" },
      ])
    ).toBe(false)
  })

  it("tolerates missing and null relation elements", () => {
    expect(hasUnpackedNativeFulfillment(null)).toBe(false)
    expect(hasUnpackedNativeFulfillment(undefined)).toBe(false)
    expect(hasUnpackedNativeFulfillment([null, undefined])).toBe(false)
  })
})
