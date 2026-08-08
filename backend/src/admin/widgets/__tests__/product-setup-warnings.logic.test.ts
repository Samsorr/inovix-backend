import {
  detectSetupIssues,
  type SetupCheckProduct,
} from "../product-setup-warnings.logic"

const fullyConfigured: SetupCheckProduct = {
  id: "prod_ok",
  status: "published",
  weight: 100,
  thumbnail: "https://example.com/img.jpg",
  shipping_profile: { id: "sp_1" },
  variants: [
    {
      id: "var_1",
      title: "Default variant",
      sku: "ABC",
      manage_inventory: true,
      prices: [{ amount: 1000 }],
      inventory_items: [
        {
          inventory: {
            id: "iitem_1",
            location_levels: [{ id: "ilev_1" }],
          },
        },
      ],
    },
  ],
}

describe("detectSetupIssues", () => {
  it("returns no issues for a fully configured product", () => {
    expect(detectSetupIssues(fullyConfigured)).toEqual([])
  })

  it("flags a product with no weight (DHL label needs it)", () => {
    const issues = detectSetupIssues({ ...fullyConfigured, weight: null })
    expect(issues.map((i) => i.key)).toEqual(["weight"])
  })

  it("flags a product with no image (no thumbnail and no images)", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      thumbnail: null,
      images: [],
    })
    expect(issues.map((i) => i.key)).toEqual(["image"])
  })

  it("accepts an image supplied via images[] when thumbnail is absent", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      thumbnail: null,
      images: [{ id: "img_1" }],
    })
    expect(issues).toEqual([])
  })

  it("flags a variant with an empty price list", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      variants: [{ ...fullyConfigured.variants![0], prices: [] }],
    })
    expect(issues.map((i) => i.key)).toEqual(["price:var_1"])
  })

  it("does NOT flag price when the prices field was not loaded (avoid false alarm)", () => {
    const v = { ...fullyConfigured.variants![0] }
    delete (v as { prices?: unknown }).prices
    expect(detectSetupIssues({ ...fullyConfigured, variants: [v] })).toEqual([])
  })

  it("flags products with no shipping profile", () => {
    const issues = detectSetupIssues({ ...fullyConfigured, shipping_profile: null })
    expect(issues.map((i) => i.key)).toContain("shipping_profile")
  })

  it("flags managed variants with no inventory_level rows | the Retatrutide bug", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      variants: [
        {
          id: "var_1",
          title: "Retatrutide",
          sku: "50",
          manage_inventory: true,
          prices: [{ amount: 1000 }],
          inventory_items: [{ inventory: { id: "iitem_x", location_levels: [] } }],
        },
      ],
    })
    expect(issues.map((i) => i.key)).toEqual(["inventory:var_1"])
    expect(issues[0].title).toContain("Retatrutide")
  })

  const unmanagedVariant = {
    id: "var_1",
    title: "Default variant",
    sku: "PT-141-Vial-10mg",
    manage_inventory: false,
    prices: [{ amount: 1000 }],
    inventory_items: [],
  }

  it("flags a published variant with manage_inventory=false | it sells with no stock check", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      status: "published",
      variants: [unmanagedVariant],
    })
    expect(issues.map((i) => i.key)).toEqual(["unmanaged:var_1"])
    expect(issues[0].title).toContain("PT-141-Vial-10mg")
    expect(issues[0].title).toContain("zonder voorraadcontrole")
    expect(issues[0].detail).toContain("meer verkopen dan er ligt")
  })

  it("does not flag manage_inventory=false on a concept product (not customer facing)", () => {
    expect(
      detectSetupIssues({
        ...fullyConfigured,
        status: "draft",
        variants: [unmanagedVariant],
      })
    ).toEqual([])
  })

  it("does not raise the missing-voorraadlocatie issue for unmanaged variants", () => {
    // An unmanaged variant genuinely needs no inventory_level; the problem we
    // report is the missing stock control itself, not the missing level.
    const issues = detectSetupIssues({
      ...fullyConfigured,
      status: "published",
      variants: [unmanagedVariant],
    })
    expect(issues.map((i) => i.key)).not.toContain("inventory:var_1")
  })

  it("falls back to SKU when variant title is the boilerplate 'Default variant'", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      variants: [
        {
          id: "var_99",
          title: "Default variant",
          sku: "RETA-50",
          manage_inventory: true,
          prices: [{ amount: 1000 }],
          inventory_items: [{ inventory: { location_levels: [] } }],
        },
      ],
    })
    expect(issues[0].title).toContain("RETA-50")
    expect(issues[0].title).not.toContain("Default variant")
  })

  it("aggregates multiple issues so the client sees the full punch list", () => {
    const issues = detectSetupIssues({
      id: "prod_bad",
      weight: null,
      shipping_profile: null,
      variants: [
        { id: "var_a", title: "100mg", manage_inventory: true, prices: [], inventory_items: [] },
        {
          id: "var_b",
          title: "250mg",
          manage_inventory: true,
          prices: [{ amount: 500 }],
          inventory_items: [{ inventory: { location_levels: [] } }],
        },
      ],
    })
    expect(issues.map((i) => i.key)).toEqual([
      "weight",
      "image",
      "shipping_profile",
      "price:var_a",
      "inventory:var_a",
      "inventory:var_b",
    ])
  })

  it("returns no issues for null/undefined input rather than throwing", () => {
    expect(detectSetupIssues(null)).toEqual([])
    expect(detectSetupIssues(undefined)).toEqual([])
  })
})
