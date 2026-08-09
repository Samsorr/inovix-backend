import { resolveText } from "../overrides"
import {
  editableFieldsFor,
  isEditableTemplate,
  EDITABLE_TEMPLATES,
} from "../editable-fields"

const LOCALES = ["nl", "de", "en"] as const

const SHIPPED_DATA = {
  order: { display_id: 28416 },
  labels: [{ tracking_number: "JVGL123", tracking_url: "https://my.dhlecommerce.nl/home/tracktrace/JVGL123/14827?lang=nl_NL" }],
}
const PLACED_DATA = { order: { display_id: 28416 } }

describe("resolveText", () => {
  it("uses the override when it has content", () => {
    expect(resolveText({ body: "Eigen tekst" }, "body", "Standaard")).toBe("Eigen tekst")
  })

  it("falls back when the override is missing, empty or whitespace", () => {
    expect(resolveText(undefined, "body", "Standaard")).toBe("Standaard")
    expect(resolveText({}, "body", "Standaard")).toBe("Standaard")
    expect(resolveText({ body: "" }, "body", "Standaard")).toBe("Standaard")
    expect(resolveText({ body: "   " }, "body", "Standaard")).toBe("Standaard")
  })

  it("ignores a non-string override", () => {
    expect(resolveText({ body: 42 } as never, "body", "Standaard")).toBe("Standaard")
  })
})

describe("editable-fields registry", () => {
  it("marks exactly the two order templates as editable", () => {
    expect([...EDITABLE_TEMPLATES].sort()).toEqual(["order-placed", "order-shipped"])
    expect(isEditableTemplate("order-shipped")).toBe(true)
    expect(isEditableTemplate("order-placed")).toBe(true)
    expect(isEditableTemplate("order-cancelled")).toBe(false)
    expect(editableFieldsFor("order-cancelled")).toEqual([])
  })

  it("exposes the agreed order-shipped fields in form order", () => {
    expect(editableFieldsFor("order-shipped").map((f) => f.key)).toEqual([
      "subject",
      "heading",
      "body",
      "trackingHeading",
      "trackingBody",
      "trackButton",
      "trackingUrl",
    ])
  })

  it("exposes the agreed order-placed fields in form order", () => {
    expect(editableFieldsFor("order-placed").map((f) => f.key)).toEqual([
      "subject",
      "heading",
      "body",
    ])
  })

  it("never exposes the greeting or the locked blocks", () => {
    const keys = [...editableFieldsFor("order-shipped"), ...editableFieldsFor("order-placed")].map((f) => f.key)
    for (const locked of ["greeting", "orderNumber", "yourOrder", "total", "inclVat", "shippingAddress", "contents", "preview"]) {
      expect(keys).not.toContain(locked)
    }
  })

  it("resolves a non-empty default for every field in every locale", () => {
    for (const locale of LOCALES) {
      for (const f of editableFieldsFor("order-shipped")) {
        expect(f.defaultFor({ locale, data: SHIPPED_DATA }).length).toBeGreaterThan(0)
      }
      for (const f of editableFieldsFor("order-placed")) {
        expect(f.defaultFor({ locale, data: PLACED_DATA }).length).toBeGreaterThan(0)
      }
    }
  })

  it("takes the tracking URL default from the first tracked label", () => {
    const field = editableFieldsFor("order-shipped").find((f) => f.key === "trackingUrl")
    expect(field!.type).toBe("url")
    expect(field!.defaultFor({ locale: "nl", data: SHIPPED_DATA })).toBe(
      SHIPPED_DATA.labels[0].tracking_url
    )
  })

  it("gives every field a Dutch label and a sane max length", () => {
    for (const template of EDITABLE_TEMPLATES) {
      for (const f of editableFieldsFor(template)) {
        expect(typeof f.label).toBe("string")
        expect(f.label.length).toBeGreaterThan(0)
        expect(f.maxLength).toBeGreaterThan(0)
      }
    }
  })
})
