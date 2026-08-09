import { validateOverrides } from "../order-email-overrides"

describe("validateOverrides", () => {
  it("accepts known keys and returns them trimmed of nothing else", () => {
    const r = validateOverrides("order-shipped", { body: "Eigen tekst", trackButton: "Volg" })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({ body: "Eigen tekst", trackButton: "Volg" })
  })

  it("treats an absent or empty payload as not edited", () => {
    expect(validateOverrides("order-shipped", undefined).value).toEqual({})
    expect(validateOverrides("order-shipped", {}).value).toEqual({})
  })

  it("drops empty and whitespace-only values so the default is restored", () => {
    const r = validateOverrides("order-shipped", { body: "", trackButton: "   ", heading: "Kop" })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({ heading: "Kop" })
  })

  it("rejects an unknown key instead of silently dropping it", () => {
    const r = validateOverrides("order-shipped", { bodyy: "typo" })
    expect(r.ok).toBe(false)
    expect(r.errors!.join(" ")).toContain("bodyy")
  })

  it("rejects a key that is not editable on this template", () => {
    const r = validateOverrides("order-placed", { trackButton: "Volg" })
    expect(r.ok).toBe(false)
    expect(r.errors!.join(" ")).toContain("trackButton")
  })

  it("rejects a non-object, an array and nested values", () => {
    expect(validateOverrides("order-shipped", "nope").ok).toBe(false)
    expect(validateOverrides("order-shipped", ["a"]).ok).toBe(false)
    expect(validateOverrides("order-shipped", { body: { nested: true } }).ok).toBe(false)
    expect(validateOverrides("order-shipped", { body: 42 }).ok).toBe(false)
  })

  it("rejects a value over the field max length", () => {
    const r = validateOverrides("order-shipped", { trackButton: "x".repeat(61) })
    expect(r.ok).toBe(false)
    expect(r.errors!.join(" ")).toContain("Knoptekst")
  })

  it("rejects a tracking URL that is not absolute http(s)", () => {
    expect(validateOverrides("order-shipped", { trackingUrl: "javascript:alert(1)" }).ok).toBe(false)
    expect(validateOverrides("order-shipped", { trackingUrl: "/relatief" }).ok).toBe(false)
    expect(validateOverrides("order-shipped", { trackingUrl: "ftp://x.nl" }).ok).toBe(false)
    expect(validateOverrides("order-shipped", { trackingUrl: "https://my.dhlecommerce.nl/x" }).ok).toBe(true)
  })

  it("rejects everything for a template that is not editable", () => {
    const r = validateOverrides("order-cancelled", { body: "x" })
    expect(r.ok).toBe(false)
  })

  it("reports Dutch error messages", () => {
    const r = validateOverrides("order-shipped", { trackingUrl: "kapot" })
    expect(r.errors!.join(" ")).toMatch(/[a-z]/)
    expect(r.errors!.join(" ")).not.toContain("must be")
  })
})
