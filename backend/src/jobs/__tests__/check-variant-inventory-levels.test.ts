jest.mock("../../lib/instrument", () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}))

import checkVariantInventoryLevels from "../check-variant-inventory-levels"
import { Sentry } from "../../lib/instrument"

const captureMessage = Sentry.captureMessage as unknown as jest.Mock

type VariantInput = {
  id: string
  sku?: string | null
  manage_inventory?: boolean | null
  product?: { title?: string | null; status?: string | null } | null
  inventory_items?: unknown[]
}

// A published variant with stock control on and a real location level: the shape
// the job should stay silent about.
function healthyVariant(id = "var_ok"): VariantInput {
  return {
    id,
    sku: "BPC-157-Vial-5mg",
    manage_inventory: true,
    product: { title: "BPC-157", status: "published" },
    inventory_items: [
      { inventory: { id: "iitem_ok", location_levels: [{ id: "ilev_1" }] } },
    ],
  }
}

function makeContainer(rows: VariantInput[]) {
  const graph = jest.fn().mockResolvedValue({ data: rows })
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container: any = {
    resolve: (key: string) => {
      if (key === "query") return { graph }
      if (key === "logger") return logger
      throw new Error(`unexpected resolve: ${key}`)
    },
  }
  return { container, graph, logger }
}

function messagesTagged(kind: string): string[] {
  return captureMessage.mock.calls
    .filter((c) => c[1]?.tags?.kind === kind)
    .map((c) => c[0] as string)
}

describe("checkVariantInventoryLevels", () => {
  beforeEach(() => captureMessage.mockClear())

  it("stays silent when every published variant is managed and stocked", async () => {
    const { container, logger } = makeContainer([healthyVariant()])
    await checkVariantInventoryLevels(container)

    expect(captureMessage).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("asks for product.status so the unmanaged check has something to filter on", async () => {
    const { container, graph } = makeContainer([healthyVariant()])
    await checkVariantInventoryLevels(container)

    expect(graph.mock.calls[0][0].fields).toContain("product.status")
  })

  // --- Check 1: managed but no inventory_level (the Retatrutide bug) ---------

  it("still reports managed variants without an inventory_level", async () => {
    const { container, logger } = makeContainer([
      {
        id: "var_orphan",
        sku: "Reta-Cart-30mg",
        manage_inventory: true,
        product: { title: "Retatrutide", status: "published" },
        inventory_items: [{ inventory: { id: "iitem_x", location_levels: [] } }],
      },
    ])
    await checkVariantInventoryLevels(container)

    const [message] = messagesTagged("inventory-level-orphan")
    expect(message).toContain("Retatrutide")
    expect(message).toContain("cart.complete will 404")
    expect(logger.warn).toHaveBeenCalledWith(message)
  })

  // --- Check 2: published but no stock control at all ------------------------

  it("reports a published variant with manage_inventory=false as a problem of its own", async () => {
    const { container, logger } = makeContainer([
      {
        id: "var_unmanaged",
        sku: "PT-141-Vial-10mg",
        manage_inventory: false,
        product: { title: "PT-141", status: "published" },
        inventory_items: [
          { inventory: { id: "iitem_pt", location_levels: [{ id: "ilev_pt" }] } },
        ],
      },
    ])
    await checkVariantInventoryLevels(container)

    const messages = messagesTagged("unmanaged-published-variant")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("PT-141")
    expect(messages[0]).toContain("PT-141-Vial-10mg")
    expect(messages[0]).toContain("manage_inventory=false")
    expect(messages[0]).toContain("WITHOUT any stock check")
    expect(logger.warn).toHaveBeenCalledWith(messages[0])

    const [, ctx] = captureMessage.mock.calls.find(
      (c) => c[1]?.tags?.kind === "unmanaged-published-variant"
    )!
    expect(ctx.level).toBe("warning")
    expect(ctx.extra.unmanagedCount).toBe(1)
    expect(ctx.extra.unmanaged).toEqual([
      { id: "var_unmanaged", sku: "PT-141-Vial-10mg", title: "PT-141" },
    ])
  })

  it("does not report unmanaged variants on non-published products", async () => {
    const { container } = makeContainer([
      {
        id: "var_draft",
        sku: "L-Carnitine-Vial",
        manage_inventory: false,
        product: { title: "L-Carnitine", status: "proposed" },
        inventory_items: [],
      },
    ])
    await checkVariantInventoryLevels(container)

    expect(messagesTagged("unmanaged-published-variant")).toHaveLength(0)
  })

  it("does not fold unmanaged variants into the missing-inventory_level alert", async () => {
    // Before this check existed the managed filter dropped them entirely, so an
    // unmanaged variant with no level at all produced nothing anywhere.
    const { container } = makeContainer([
      {
        id: "var_unmanaged_nolevel",
        sku: "B12-Cart-30mg",
        manage_inventory: false,
        product: { title: "B12 Hydroxocobalamine", status: "published" },
        inventory_items: [],
      },
    ])
    await checkVariantInventoryLevels(container)

    expect(messagesTagged("inventory-level-orphan")).toHaveLength(0)
    expect(messagesTagged("unmanaged-published-variant")).toHaveLength(1)
  })

  it("reports both problems in the same run, as separate alerts", async () => {
    const { container } = makeContainer([
      healthyVariant(),
      {
        id: "var_orphan",
        sku: "Reta-Cart-30mg",
        manage_inventory: true,
        product: { title: "Retatrutide", status: "published" },
        inventory_items: [{ inventory: { id: "iitem_x", location_levels: [] } }],
      },
      {
        id: "var_unmanaged",
        sku: "Semax-Vial-10mg",
        manage_inventory: false,
        product: { title: "Semax", status: "published" },
        inventory_items: [
          { inventory: { id: "iitem_s", location_levels: [{ id: "ilev_s" }] } },
        ],
      },
    ])
    await checkVariantInventoryLevels(container)

    expect(captureMessage).toHaveBeenCalledTimes(2)
    expect(messagesTagged("inventory-level-orphan")[0]).toContain("Retatrutide")
    expect(messagesTagged("unmanaged-published-variant")[0]).toContain("Semax")
  })

  it("names every affected variant rather than only counting them", async () => {
    const { container } = makeContainer([
      {
        id: "var_a",
        sku: "Admax-Spray-10mg",
        manage_inventory: false,
        product: { title: "Adamax", status: "published" },
        inventory_items: [],
      },
      {
        id: "var_b",
        sku: null,
        manage_inventory: null,
        product: { title: null, status: "published" },
        inventory_items: [],
      },
    ])
    await checkVariantInventoryLevels(container)

    const [message] = messagesTagged("unmanaged-published-variant")
    expect(message).toContain("2 published variant(s)")
    expect(message).toContain("Adamax (sku=Admax-Spray-10mg)")
    expect(message).toContain("(untitled) (sku=(no sku))")
  })
})
