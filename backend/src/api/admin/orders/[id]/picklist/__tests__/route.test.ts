import { GET } from "../route"

// The exact live-prod shape from commit bf77956: query.graph returns
// items.quantity as undefined and only items.detail carries the real number.
// Two earlier "picklist 0x" fixes (Number(i.quantity ?? 0) and
// toAmount(i.quantity)) both render 0 for this shape, which prints
// "0x BPC-157" on the paper a human packs from.
const LIVE_ITEMS_UNDEFINED_QUANTITY = [
  {
    id: "item_1",
    quantity: undefined,
    title: "BPC-157",
    product_title: "BPC-157",
    variant_title: "5mg",
    variant_sku: "BPC-5",
    detail: { quantity: 2, raw_quantity: { value: "2", precision: 20 } },
  },
  {
    id: "item_2",
    quantity: undefined,
    title: "TB-500",
    product_title: "TB-500",
    variant_title: "10mg",
    variant_sku: "TB-10",
    // Only the bigNumber raw shape resolves here.
    detail: { quantity: undefined, raw_quantity: { value: "3", precision: 20 } },
  },
]

function makeRes() {
  const res: any = { statusCode: 0, body: "", headers: {} }
  res.status = (c: number) => ((res.statusCode = c), res)
  res.send = (b: string) => ((res.body = b), res)
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res)
  return res
}

function makeReq(order: unknown) {
  const graph = jest.fn().mockResolvedValue({ data: order ? [order] : [] })
  const req: any = {
    params: { id: "order_1" },
    scope: {
      resolve: (key: string) => {
        if (key === "query") return { graph }
        throw new Error(`unexpected resolve: ${key}`)
      },
    },
  }
  return { req, graph }
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    display_id: 28411,
    created_at: "2026-07-14T08:00:00.000Z",
    email: "jan@example.com",
    metadata: {},
    shipping_address: {
      first_name: "Jan",
      last_name: "Jansen",
      address_1: "Straatweg 1",
      postal_code: "1234 AB",
      city: "Amsterdam",
      country_code: "nl",
    },
    items: LIVE_ITEMS_UNDEFINED_QUANTITY,
    shipping_methods: [{ id: "sm_1", data: { dhl_option: "DOOR" } }],
    ...overrides,
  }
}

describe("GET /admin/orders/:id/picklist", () => {
  it("prints the real quantity when items.quantity comes back undefined", async () => {
    const { req } = makeReq(order())
    const res = makeRes()
    await GET(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(">2x<")
    expect(res.body).toContain(">3x<")
    expect(res.body).not.toContain(">0x<")
  })

  it("requests every quantity shape from query.graph", async () => {
    const { req, graph } = makeReq(order())
    await GET(req, makeRes())

    const fields = graph.mock.calls[0][0].fields
    expect(fields).toEqual(
      expect.arrayContaining([
        "items.quantity",
        "items.raw_quantity",
        "items.detail.quantity",
        "items.detail.raw_quantity",
      ])
    )
  })

  it("prints ?x instead of 0x when no shape carries a quantity", async () => {
    const { req } = makeReq(
      order({ items: [{ id: "item_1", product_title: "BPC-157", quantity: undefined, detail: null }] })
    )
    const res = makeRes()
    await GET(req, res)

    expect(res.body).toContain(">?x<")
    expect(res.body).not.toContain(">0x<")
  })

  it("still renders a plain numeric quantity", async () => {
    const { req } = makeReq(
      order({ items: [{ id: "item_1", product_title: "BPC-157", quantity: 4 }] })
    )
    const res = makeRes()
    await GET(req, res)

    expect(res.body).toContain(">4x<")
  })

  it("prints the remaining lines when the items array holds a null element", async () => {
    const { req } = makeReq(
      order({ items: [null, { id: "item_1", product_title: "BPC-157", quantity: 2 }] })
    )
    const res = makeRes()
    await GET(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(">2x<")
  })

  it("404s when the order does not exist", async () => {
    const { req } = makeReq(null)
    const res = makeRes()
    await GET(req, res)

    expect(res.statusCode).toBe(404)
  })
})
