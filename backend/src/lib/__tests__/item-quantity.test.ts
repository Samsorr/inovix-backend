import {
  asQty,
  firstQty,
  itemQuantity,
  ITEM_QUANTITY_FIELDS,
} from "../item-quantity"

describe("itemQuantity", () => {
  // The exact shape live prod returned in commit bf77956: the explicitly
  // selected items.quantity is undefined and the real value only exists on
  // items.detail. This is the shape two earlier "picklist 0x" fixes missed.
  it("resolves the live shape where items.quantity is undefined", () => {
    expect(
      itemQuantity({ quantity: undefined, detail: { quantity: 2 } })
    ).toBe(2)
  })

  it("resolves bigNumber { value, precision } objects", () => {
    expect(
      itemQuantity({ quantity: undefined, detail: { raw_quantity: { value: "3", precision: 20 } } })
    ).toBe(3)
  })

  it("prefers the plain quantity when it is a usable number", () => {
    expect(itemQuantity({ quantity: 5, detail: { quantity: 99 } })).toBe(5)
  })

  it("returns null when no shape carries a number (never 0)", () => {
    expect(itemQuantity({ quantity: undefined, detail: null })).toBeNull()
    expect(itemQuantity({ quantity: "abc" })).toBeNull()
    expect(itemQuantity(null)).toBeNull()
    expect(itemQuantity(undefined)).toBeNull()
  })

  it("keeps a real zero distinguishable from unresolvable", () => {
    expect(itemQuantity({ quantity: 0 })).toBe(0)
  })
})

describe("asQty / firstQty", () => {
  it("parses numbers, numeric strings and nested value objects", () => {
    expect(asQty(4)).toBe(4)
    expect(asQty("4")).toBe(4)
    expect(asQty({ value: "4", precision: 20 })).toBe(4)
    expect(asQty({ value: null })).toBeNull()
    expect(asQty(undefined)).toBeNull()
  })

  it("returns the first resolvable value", () => {
    expect(firstQty(undefined, null, "7", 9)).toBe(7)
    expect(firstQty(undefined, null)).toBeNull()
  })
})

describe("ITEM_QUANTITY_FIELDS", () => {
  it("lists all four query.graph shapes", () => {
    expect(ITEM_QUANTITY_FIELDS).toEqual([
      "items.quantity",
      "items.raw_quantity",
      "items.detail.quantity",
      "items.detail.raw_quantity",
    ])
  })
})
