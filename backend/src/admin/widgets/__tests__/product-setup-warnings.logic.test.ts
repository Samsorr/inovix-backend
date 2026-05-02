import {
  detectSetupIssues,
  type SetupCheckProduct,
} from "../product-setup-warnings.logic"

const fullyConfigured: SetupCheckProduct = {
  id: "prod_ok",
  shipping_profile: { id: "sp_1" },
  variants: [
    {
      id: "var_1",
      title: "Default variant",
      sku: "ABC",
      manage_inventory: true,
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
  it("returns no issues for a properly configured product", () => {
    expect(detectSetupIssues(fullyConfigured)).toEqual([])
  })

  it("flags products with no shipping profile", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      shipping_profile: null,
    })
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
          inventory_items: [
            { inventory: { id: "iitem_x", location_levels: [] } },
          ],
        },
      ],
    })
    expect(issues.length).toBe(1)
    expect(issues[0].key).toBe("inventory:var_1")
    expect(issues[0].title).toContain("Retatrutide")
  })

  it("ignores variants where manage_inventory is false (digital / no-stock items)", () => {
    expect(
      detectSetupIssues({
        ...fullyConfigured,
        variants: [
          {
            id: "var_1",
            title: "Default variant",
            sku: "ABC",
            manage_inventory: false,
            inventory_items: [],
          },
        ],
      })
    ).toEqual([])
  })

  it("falls back to SKU when variant title is the boilerplate 'Default variant'", () => {
    const issues = detectSetupIssues({
      ...fullyConfigured,
      shipping_profile: { id: "sp_1" },
      variants: [
        {
          id: "var_99",
          title: "Default variant",
          sku: "RETA-50",
          manage_inventory: true,
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
      shipping_profile: null,
      variants: [
        {
          id: "var_a",
          title: "100mg",
          manage_inventory: true,
          inventory_items: [],
        },
        {
          id: "var_b",
          title: "250mg",
          manage_inventory: true,
          inventory_items: [{ inventory: { location_levels: [] } }],
        },
      ],
    })
    expect(issues.map((i) => i.key)).toEqual([
      "shipping_profile",
      "inventory:var_a",
      "inventory:var_b",
    ])
  })

  it("returns no issues for null/undefined input rather than throwing", () => {
    expect(detectSetupIssues(null)).toEqual([])
    expect(detectSetupIssues(undefined)).toEqual([])
  })
})
