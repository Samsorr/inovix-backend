import { describeLabelFailure, sanitizeErrorDetail } from "../dhl-label-error"

// Every message below is a real one from the label path:
//  - modules/dhl-parcel/client.ts builds the "DHL Parcel <METHOD> <path>
//    failed with <status>" messages (DhlParcelApiError extends Error, NOT
//    MedusaError, so all of them used to land in the route's default branch)
//  - workflows/create-dhl-parcel-shipment/steps/validate-order.ts throws the
//    MedusaError ones
//  - modules/dhl-parcel/box-selector.ts throws the weight/preset ones
describe("describeLabelFailure", () => {
  it("tells the operator an expired DHL key is not worth retrying", () => {
    const v = describeLabelFailure("DHL Parcel POST /labels failed with 401 after re-auth")
    expect(v.code).toBe("dhl_auth")
    expect(v.message).toContain("geweigerd")
    expect(v.message).toContain("beheerder")
    expect(v.details).toContain("401")
  })

  it("separates a DHL rejection from a DHL outage", () => {
    const rejected = describeLabelFailure("DHL Parcel POST /labels failed with 400")
    expect(rejected.code).toBe("dhl_rejected")
    expect(rejected.message).toContain("bezorgadres")

    const down = describeLabelFailure("DHL Parcel POST /labels failed with 503 after retry")
    expect(down.code).toBe("dhl_unavailable")
    expect(down.message).toContain("paar minuten")

    // The four cases must not read alike, which is the whole defect.
    expect(rejected.message).not.toBe(down.message)
  })

  it("recognises a network failure", () => {
    expect(describeLabelFailure("fetch failed").code).toBe("no_connection")
    expect(describeLabelFailure("connect ETIMEDOUT 1.2.3.4:443").code).toBe("no_connection")
  })

  it("keeps the Dutch product-weight error verbatim because it names the product", () => {
    const raw =
      'Product "BPC-157 5mg" heeft nog geen gewicht. Stel een gewicht (in gram) in op dit product en probeer het opnieuw.'
    const v = describeLabelFailure(raw)
    expect(v.code).toBe("missing_weight")
    expect(v.message).toBe(raw)
  })

  it("translates the English weight error from the box selector", () => {
    const v = describeLabelFailure(
      "Cannot compute shipment weight: an order item is missing a product weight"
    )
    expect(v.code).toBe("missing_weight")
    expect(v.message).toContain("gewicht")
    expect(v.message).not.toMatch(/[a-z] weight/i)
  })

  it("points at the settings page when the last box preset was deleted", () => {
    for (const raw of [
      "No DHL Parcel box presets configured",
      "Cannot select a box preset: no presets provided",
    ]) {
      const v = describeLabelFailure(raw)
      expect(v.code).toBe("no_box_presets")
      expect(v.message).toContain("doosformaten")
    }
  })

  it("translates the remaining English validate-order errors", () => {
    expect(describeLabelFailure("Order has no DHL Parcel shipping method")).toMatchObject({
      code: "no_shipping_method",
    })
    expect(describeLabelFailure("Order has no items, geen DHL Parcel-label mogelijk")).toMatchObject(
      { code: "no_items" }
    )
    const canceled = describeLabelFailure("Order is canceled, geen DHL Parcel-label mogelijk")
    expect(canceled.code).toBe("order_not_shippable")
    expect(canceled.message).toContain("canceled")
    for (const v of [
      describeLabelFailure("Order has no DHL Parcel shipping method"),
      describeLabelFailure("Order has no items, geen DHL Parcel-label mogelijk"),
      canceled,
    ]) {
      expect(v.message).not.toMatch(/^Order /)
    }
  })

  it("passes the payment gate's own Dutch sentence through untouched", () => {
    const raw =
      "De betaling is nog niet (volledig) ontvangen | geen DHL-label mogelijk. Controleer de betaling op de bestelpagina of gebruik de override met reden."
    const v = describeLabelFailure(raw)
    expect(v.code).toBe("payment")
    expect(v.message).toBe(raw)
  })

  it("still says something useful for an unknown error, and keeps the raw text", () => {
    const v = describeLabelFailure("Cannot read properties of undefined (reading 'strategy')")
    expect(v.code).toBe("unknown")
    expect(v.message).toContain("technische melding")
    expect(v.details).toContain("strategy")
  })

  it("never answers with the old one-size-fits-all English sentence", () => {
    const causes = [
      "DHL Parcel POST /labels failed with 401 after re-auth",
      "DHL Parcel POST /labels failed with 400",
      "DHL Parcel POST /labels failed with 503 after retry",
      "fetch failed",
      "Cannot compute shipment weight: an order item is missing a product weight",
      "No DHL Parcel box presets configured",
    ]
    const messages = causes.map((c) => describeLabelFailure(c).message)
    expect(new Set(messages).size).toBe(causes.length)
    for (const m of messages) {
      expect(m).not.toContain("DHL label creation failed")
    }
  })

  it("degrades to the unknown case for an empty message instead of throwing", () => {
    expect(describeLabelFailure(undefined).code).toBe("unknown")
    expect(describeLabelFailure(null).details).toBeNull()
  })
})

describe("sanitizeErrorDetail", () => {
  it("keeps the useful part and drops credentials", () => {
    const s = sanitizeErrorDetail(
      'DHL auth failed: {"api_key":"abc123def456","message":"invalid"}'
    )
    expect(s).toContain("DHL auth failed")
    expect(s).toContain("invalid")
    expect(s).not.toContain("abc123def456")
    expect(s).toContain("[verwijderd]")
  })

  it("drops bearer tokens and JWTs", () => {
    const s = sanitizeErrorDetail(
      "401 with header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
    )
    expect(s).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(s).toContain("401")
  })

  it("drops query strings, which can carry a token", () => {
    const s = sanitizeErrorDetail("GET https://api.dhl.com/labels?access_token=xyz failed")
    expect(s).not.toContain("xyz")
    expect(s).toContain("https://api.dhl.com/labels")
  })

  it("truncates a runaway message and normalises whitespace", () => {
    const s = sanitizeErrorDetail(`boom\n\n   ${"stack frame ".repeat(300)}`)
    expect(s!.length).toBeLessThanOrEqual(503)
    expect(s!.startsWith("boom stack frame")).toBe(true)
    expect(s!.endsWith("...")).toBe(true)
  })

  it("redacts a long opaque blob, which is almost always a credential", () => {
    const s = sanitizeErrorDetail(`boom ${"x".repeat(60)}`)
    expect(s).toBe("boom [verwijderd]")
  })

  it("returns null for nothing at all", () => {
    expect(sanitizeErrorDetail(null)).toBeNull()
    expect(sanitizeErrorDetail("   ")).toBeNull()
  })
})
