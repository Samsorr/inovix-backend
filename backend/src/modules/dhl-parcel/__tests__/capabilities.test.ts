import { selectDhlOptions } from "../capabilities"

// Fixtures trimmed from real GET /capabilities/business responses against the
// prod gateway (2026-08-08). Only the fields the selector reads are kept.
const NL_SMALL = {
  product: { key: "DFY-B2C", label: "DFY" },
  parcelType: { key: "SMALL" },
  options: [
    { key: "PS", optionType: "DELIVERY_OPTION", exclusions: [{ key: "DOOR" }, { key: "HANDT" }] },
    { key: "DOOR", optionType: "DELIVERY_OPTION", exclusions: [{ key: "PS" }] },
    { key: "REFERENCE", optionType: "SERVICE_OPTION" },
    { key: "HANDT", optionType: "SERVICE_OPTION", exclusions: [{ key: "PS" }] },
    { key: "SSN", optionType: "SERVICE_OPTION" },
  ],
}

// NL -> DE: DHL PARCEL CONNECT / EUROPLUS. No HANDT, no SSN anywhere.
const DE_SMALL_CON = {
  product: { key: "CON", label: "DHL PARCEL CONNECT" },
  parcelType: { key: "SMALL" },
  options: [
    { key: "PS", optionType: "DELIVERY_OPTION", exclusions: [{ key: "DOOR" }] },
    { key: "DOOR", optionType: "DELIVERY_OPTION", exclusions: [{ key: "PS" }] },
    { key: "REFERENCE", optionType: "SERVICE_OPTION" },
  ],
}
const DE_SMALL_EPL = {
  product: { key: "EPL-INT", label: "EUROPLUS" },
  parcelType: { key: "SMALL" },
  options: [
    { key: "DOOR", optionType: "DELIVERY_OPTION" },
    { key: "REFERENCE", optionType: "SERVICE_OPTION" },
    { key: "LQ", optionType: "SERVICE_OPTION" },
  ],
}

describe("selectDhlOptions", () => {
  it("keeps every wanted option when the destination offers them (NL domestic)", () => {
    const sel = selectDhlOptions([NL_SMALL], "SMALL", ["DOOR"], ["REFERENCE", "HANDT", "SSN"])

    expect(sel).not.toBeNull()
    expect(sel!.keys).toEqual(["DOOR", "REFERENCE", "HANDT", "SSN"])
    expect(sel!.dropped).toEqual([])
    expect(sel!.productKey).toBe("DFY-B2C")
  })

  // The order #28416 failure: DHL answers POST /labels with 400
  // capabilities_retrieve_empty when an option is not offered for the lane.
  it("drops options the destination does not offer (NL -> DE has no HANDT/SSN)", () => {
    const sel = selectDhlOptions(
      [DE_SMALL_CON, DE_SMALL_EPL],
      "SMALL",
      ["DOOR"],
      ["REFERENCE", "HANDT", "SSN"],
    )

    expect(sel).not.toBeNull()
    expect(sel!.keys).toEqual(["DOOR", "REFERENCE"])
    expect(sel!.dropped).toEqual(["HANDT", "SSN"])
  })

  it("honours exclusions: HANDT is dropped for a Servicepunt shipment", () => {
    const sel = selectDhlOptions([NL_SMALL], "SMALL", ["PS"], ["REFERENCE", "HANDT", "SSN"])

    expect(sel!.keys).toEqual(["PS", "REFERENCE", "SSN"])
    expect(sel!.dropped).toEqual(["HANDT"])
  })

  it("prefers the product that supports the most wanted options", () => {
    // EPL-INT comes first but offers neither HANDT nor SSN; the selector must
    // still pick the richer product rather than the first match.
    const rich = { ...DE_SMALL_CON, options: [...DE_SMALL_CON.options, { key: "SSN" }] }
    const sel = selectDhlOptions([DE_SMALL_EPL, rich], "SMALL", ["DOOR"], ["REFERENCE", "SSN"])

    expect(sel!.productKey).toBe("CON")
    expect(sel!.keys).toEqual(["DOOR", "REFERENCE", "SSN"])
  })

  it("returns null when the parcel type is not available for the destination", () => {
    // XSMALL exists NL -> NL but not NL -> DE.
    expect(selectDhlOptions([DE_SMALL_CON], "XSMALL", ["DOOR"], ["REFERENCE"])).toBeNull()
  })

  it("returns null when no product offers the required delivery option", () => {
    // Servicepunt is not offered by EUROPLUS.
    expect(selectDhlOptions([DE_SMALL_EPL], "SMALL", ["PS"], ["REFERENCE"])).toBeNull()
  })

  it("matches parcel type case-insensitively", () => {
    expect(selectDhlOptions([DE_SMALL_CON], "small", ["DOOR"], [])!.keys).toEqual(["DOOR"])
  })

  it("returns null for a malformed/empty capabilities response", () => {
    expect(selectDhlOptions(null, "SMALL", ["DOOR"], [])).toBeNull()
    expect(selectDhlOptions([], "SMALL", ["DOOR"], [])).toBeNull()
    expect(selectDhlOptions({ error: "nope" }, "SMALL", ["DOOR"], [])).toBeNull()
  })
})
