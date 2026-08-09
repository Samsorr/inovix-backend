/* eslint-disable @typescript-eslint/no-var-requires */
// The template modules use JSX without importing React and SWC compiles them
// with the classic runtime, so React has to be on the global before anything
// under templates/ loads. Same preamble as
// modules/email-notifications/__tests__/templates.test.tsx.
const React = require("react")
;(globalThis as any).React = React

// Element stubs instead of the real react-email components: the real ones make
// renderToStaticMarkup suspend under load (the known templates.test.tsx flake),
// and this suite is about the routes, not about react-email's own markup.
jest.mock("@react-email/components", () => {
  const R = require("react")
  const wrap =
    (tag: string) =>
    ({ children, ...props }: any) =>
      R.createElement(tag, props, children)
  const passthrough = ({ children }: any) => R.createElement(R.Fragment, null, children)
  return {
    Button: wrap("a"),
    Link: wrap("a"),
    Section: wrap("div"),
    Text: wrap("p"),
    Img: (props: any) => R.createElement("img", props),
    Hr: () => R.createElement("hr"),
    Html: passthrough,
    Body: passthrough,
    Container: wrap("div"),
    Preview: passthrough,
    Tailwind: passthrough,
    Head: () => null,
    Row: wrap("div"),
    Column: wrap("span"),
  }
})

// The real `render` dynamically imports react-dom/server, which jest's CJS VM
// refuses ("A dynamic import callback was invoked without
// --experimental-vm-modules"). The stub renders the SAME element tree the route
// hands it, so the html assertions below are real assertions about the
// template, and the route still has to call render() to produce any html.
jest.mock("@react-email/render", () => ({
  render: jest.fn(async (element: any) =>
    require("react-dom/server").renderToStaticMarkup(element)
  ),
}))

// Pulled in through mark-dhl-shipped; it imports @medusajs/medusa/core-flows,
// which has no business loading in a route unit test.
jest.mock("../../../../../../lib/auto-complete-order", () => ({
  autoCompleteOrderIfDone: jest.fn().mockResolvedValue(false),
}))

jest.mock("../../../../../../modules/email-notifications/send-notification", () => ({
  sendEmailNotification: jest.fn().mockResolvedValue({
    sent: true,
    attempt: 1,
    idempotency_key: "key",
  }),
}))

// markDhlOrderShipped runs for real below (that is the point: the edited
// shipped mail must still go through it), only its email helper is doubled.
jest.mock("../../../../../../subscribers/_helpers/send-order-shipped", () => ({
  sendOrderShippedNotification: jest.fn().mockResolvedValue({ sent: true }),
}))

import { POST as SEND_SHIPPED } from "../../dhl-label/send-email/route"
import { GET as DRAFT } from "../draft/route"
import { POST as PREVIEW } from "../preview/route"
import { POST as SEND } from "../send/route"

const { render } = jest.requireMock("@react-email/render") as { render: jest.Mock }
const { sendEmailNotification } = jest.requireMock(
  "../../../../../../modules/email-notifications/send-notification"
) as { sendEmailNotification: jest.Mock }
const { sendOrderShippedNotification } = jest.requireMock(
  "../../../../../../subscribers/_helpers/send-order-shipped"
) as { sendOrderShippedNotification: jest.Mock }

const ORDER_ID = "order_1"
const FULFILLMENT_ID = "ful_1"
const TRACKING_URL =
  "https://my.dhlecommerce.nl/home/tracktrace/JVGL123/14827?lang=nl_NL"

const SHIPPING_ADDRESS = {
  first_name: "Sarah",
  last_name: "Lenze",
  address_1: "Schmerwitz 45C",
  address_2: null,
  company: null,
  city: "Wiesenburg",
  province: null,
  postal_code: "14827",
  country_code: "nl",
}

function dhlFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: FULFILLMENT_ID,
    provider_id: "dhl-parcel_dhl-parcel",
    canceled_at: null,
    shipped_at: "2026-08-08T10:00:00.000Z",
    data: { dhl_tracking_number: "JVGL123" },
    labels: [
      {
        tracking_number: "JVGL123",
        tracking_url: TRACKING_URL,
        label_url: null,
      },
    ],
    items: [{ id: "fi_1", line_item_id: "item_1", quantity: 1 }],
    ...overrides,
  }
}

function graphOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    display_id: "28416",
    email: "klant@example.com",
    currency_code: "eur",
    shipping_address: SHIPPING_ADDRESS,
    items: [
      {
        id: "item_1",
        title: "GHK-Cu 50mg",
        product_title: "GHK-Cu",
        variant_title: "50mg",
        detail: { fulfilled_quantity: 1, shipped_quantity: 0 },
      },
    ],
    fulfillments: [dhlFulfillment()],
    ...overrides,
  }
}

function retrievedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    display_id: "28416",
    email: "klant@example.com",
    currency_code: "eur",
    created_at: "2026-08-08T09:00:00.000Z",
    metadata: null,
    shipping_address: SHIPPING_ADDRESS,
    items: [
      {
        id: "item_1",
        product_title: "GHK-Cu",
        variant_title: "50mg",
        title: "GHK-Cu 50mg",
        quantity: 1,
        unit_price: 49.95,
      },
    ],
    summary: { raw_current_order_total: { value: 56.9 } },
    ...overrides,
  }
}

function makeScope(
  opts: { orders?: unknown[]; order?: unknown } = {}
): { scope: any; logger: any } {
  const orders = opts.orders ?? [graphOrder()]
  const order = "order" in opts ? opts.order : retrievedOrder()

  const graph = jest.fn(({ entity }: { entity: string }) => {
    if (entity === "order") return Promise.resolve({ data: orders })
    if (entity === "order_fulfillment")
      return Promise.resolve({ data: [{ order_id: ORDER_ID }] })
    // No linked cart: the locale falls back to Dutch, like most real orders.
    return Promise.resolve({ data: [] })
  })

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const scope = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "query") return { graph }
      if (key === "order")
        return {
          retrieveOrder: jest.fn().mockResolvedValue(order),
          registerShipment: jest.fn().mockResolvedValue({}),
        }
      // Only markDhlOrderShipped needs this one.
      if (key === "fulfillment")
        return { updateFulfillment: jest.fn().mockResolvedValue({}) }
      throw new Error(`unexpected resolve: ${key}`)
    }),
  }

  return { scope, logger }
}

function makeReq(input: {
  body?: Record<string, unknown>
  query?: Record<string, unknown>
  scope?: any
}) {
  return {
    params: { id: ORDER_ID },
    query: input.query ?? {},
    body: input.body,
    scope: input.scope,
  } as any
}

function makeRes() {
  const res: any = { statusCode: 200, body: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((payload: unknown) => {
    res.body = payload
    return res
  })
  return res
}

describe("GET /admin/orders/:id/email/draft", () => {
  it("returns every editable field prefilled with the registry default", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await DRAFT(makeReq({ query: { template: "order-shipped" }, scope }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.template).toBe("order-shipped")
    expect(res.body.to).toBe("klant@example.com")
    expect(res.body.locale).toBe("nl")
    expect(res.body.fields.map((f: any) => f.key)).toEqual([
      "subject",
      "heading",
      "body",
      "trackingHeading",
      "trackingBody",
      "trackButton",
      "trackingCode",
      "trackingUrl",
    ])

    const byKey = Object.fromEntries(
      res.body.fields.map((f: any) => [f.key, f])
    )
    expect(byKey.subject.value).toBe("Uw bestelling is onderweg | Inovix 28416")
    expect(byKey.subject.label).toBe("Onderwerp")
    expect(byKey.body.type).toBe("textarea")
    expect(byKey.trackButton.value).toBe("Volg uw pakket")
    // The default has to be the link that would really be sent, so the
    // operator edits the URL the customer would otherwise get.
    expect(byKey.trackingUrl.type).toBe("url")
    expect(byKey.trackingUrl.value).toBe(TRACKING_URL)
    expect(byKey.trackingUrl.maxLength).toBeGreaterThan(0)
  })

  it("prefills the confirmation fields for order-placed", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await DRAFT(makeReq({ query: { template: "order-placed" }, scope }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.fields.map((f: any) => f.key)).toEqual([
      "subject",
      "heading",
      "body",
    ])
    expect(res.body.fields[0].value).toBe("Bestelling bevestigd | Inovix 28416")
  })

  it("404s in Dutch for a template that is not editable", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await DRAFT(makeReq({ query: { template: "order-cancelled" }, scope }), res)

    expect(res.statusCode).toBe(404)
    expect(res.body.message).toContain("order-cancelled")
    expect(res.body.message).toContain("kan niet bewerkt worden")
  })

  it("404s when the composer cannot build the email", async () => {
    // No DHL fulfillment: there is no shipped mail to draft.
    const { scope } = makeScope({ orders: [graphOrder({ fulfillments: [] })] })
    const res = makeRes()

    await DRAFT(makeReq({ query: { template: "order-shipped" }, scope }), res)

    expect(res.statusCode).toBe(404)
    expect(res.body.message).toBe(
      "Deze e-mail kan niet voor deze bestelling opgesteld worden."
    )
  })
})

describe("POST /admin/orders/:id/email/preview", () => {
  it("renders the overridden copy through the real template", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await PREVIEW(
      makeReq({
        scope,
        body: {
          template: "order-shipped",
          overrides: {
            subject: "Uw pakket is vandaag verstuurd",
            heading: "Onderweg naar u",
            body: "Wij hebben uw pakket vanmiddag afgegeven bij DHL.",
            trackButton: "Bekijk status",
            trackingUrl: "https://example.com/anders",
          },
        },
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.subject).toBe("Uw pakket is vandaag verstuurd")
    expect(res.body.html).toContain("Onderweg naar u")
    expect(res.body.html).toContain(
      "Wij hebben uw pakket vanmiddag afgegeven bij DHL."
    )
    expect(res.body.html).toContain("Bekijk status")
    expect(res.body.html).toContain("https://example.com/anders")
    expect(res.body.html).not.toContain(
      "Uw pakket is zojuist overgedragen aan de vervoerder"
    )
    // The locked blocks survive an edit.
    expect(res.body.html).toContain("Sarah")
    expect(res.body.html).toContain("Inhoud van deze zending")
  })

  it("renders the standard copy when nothing was edited", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await PREVIEW(makeReq({ scope, body: { template: "order-shipped" } }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.subject).toBe("Uw bestelling is onderweg | Inovix 28416")
    expect(res.body.html).toContain(
      "Uw pakket is zojuist overgedragen aan de vervoerder"
    )
    expect(res.body.html).toContain("Volg uw pakket")
    expect(res.body.html).toContain(TRACKING_URL)
  })

  it("400s with the offending field and renders nothing", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await PREVIEW(
      makeReq({
        scope,
        body: {
          template: "order-shipped",
          overrides: { trackingUrl: "javascript:alert(1)" },
        },
      }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe("Controleer de ingevulde velden")
    expect(res.body.errors.join(" ")).toContain("Tracking-link")
    expect(render).not.toHaveBeenCalled()
  })

  it("400s on an unknown field instead of silently dropping it", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await PREVIEW(
      makeReq({ scope, body: { template: "order-placed", overrides: { bodyy: "typo" } } }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.errors.join(" ")).toContain("bodyy")
    expect(render).not.toHaveBeenCalled()
  })

  it("404s for a template that is not editable", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await PREVIEW(makeReq({ scope, body: { template: "order-cancelled" } }), res)

    expect(res.statusCode).toBe(404)
    expect(render).not.toHaveBeenCalled()
  })

  it("404s when the composer cannot build the email", async () => {
    const { scope } = makeScope({ orders: [graphOrder({ fulfillments: [] })] })
    const res = makeRes()

    await PREVIEW(makeReq({ scope, body: { template: "order-shipped" } }), res)

    expect(res.statusCode).toBe(404)
  })
})

describe("POST /admin/orders/:id/email/send", () => {
  it("sends the edited confirmation with a unique key and the overrides in data", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({
        scope,
        body: {
          template: "order-placed",
          overrides: { body: "Wij pakken uw bestelling morgen in." },
        },
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ sent: true, edited: true })

    expect(sendEmailNotification).toHaveBeenCalledTimes(1)
    const input = sendEmailNotification.mock.calls[0][1]
    expect(input.to).toBe("klant@example.com")
    expect(input.template).toBe("order-placed")
    expect(input.resource_id).toBe(ORDER_ID)
    expect(input.resource_type).toBe("order")
    expect(input.trigger_type).toBe("admin.edited")
    expect(input.idempotency_key).toMatch(
      new RegExp(`^order-confirmed-${ORDER_ID}-edited-\\d+$`)
    )
    expect(input.data.overrides).toEqual({
      body: "Wij pakken uw bestelling morgen in.",
    })
    expect(input.data.edited).toBe(true)
  })

  it("puts an edited subject in emailOptions and not in overrides", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({
        scope,
        body: {
          template: "order-placed",
          overrides: { subject: "Uw bestelling bij ons" },
        },
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    const input = sendEmailNotification.mock.calls[0][1]
    expect(input.data.emailOptions.subject).toBe("Uw bestelling bij ons")
    // The provider reads the subject from emailOptions; a second copy in
    // overrides would be free to drift from it.
    expect(input.data.overrides).toBeUndefined()
    // A subject-only edit is still an edit, and the sent list must say so.
    expect(input.data.edited).toBe(true)
  })

  it("sends an all-empty override set with no overrides key at all", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({
        scope,
        body: { template: "order-placed", overrides: { body: "   ", heading: "" } },
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.edited).toBe(false)
    const input = sendEmailNotification.mock.calls[0][1]
    expect("overrides" in input.data).toBe(false)
    expect("edited" in input.data).toBe(false)
    expect(input.trigger_type).toBe("admin.resend")
    expect(input.data.emailOptions.subject).toBe(
      "Bestelling bevestigd | Inovix 28416"
    )
  })

  it("400s on invalid overrides and sends nothing", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({
        scope,
        body: { template: "order-placed", overrides: { heading: "x".repeat(121) } },
      }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe("Controleer de ingevulde velden")
    expect(res.body.errors.join(" ")).toContain("Kop")
    expect(sendEmailNotification).not.toHaveBeenCalled()
  })

  it("400s on a nested override value", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({
        scope,
        body: { template: "order-placed", overrides: { body: { nested: true } } },
      }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(sendEmailNotification).not.toHaveBeenCalled()
  })

  // The shipped mail carries a side effect (mark shipped + register shipment +
  // close the order). A generic send path without it would tell the customer
  // the parcel is on its way while the admin still lists the order unshipped.
  it("refuses order-shipped and points at the mark-shipped route", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(
      makeReq({ scope, body: { template: "order-shipped", overrides: { body: "x" } } }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toContain("markeer als verzonden")
    expect(sendEmailNotification).not.toHaveBeenCalled()
  })

  it("404s for a template that is not editable", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(makeReq({ scope, body: { template: "order-cancelled" } }), res)

    expect(res.statusCode).toBe(404)
    expect(sendEmailNotification).not.toHaveBeenCalled()
  })

  it("404s when the composer cannot build the email", async () => {
    const { scope } = makeScope({
      order: retrievedOrder({ shipping_address: null }),
    })
    const res = makeRes()

    await SEND(makeReq({ scope, body: { template: "order-placed" } }), res)

    expect(res.statusCode).toBe(404)
    expect(sendEmailNotification).not.toHaveBeenCalled()
  })

  it("500s in Dutch when the send throws, without claiming success", async () => {
    sendEmailNotification.mockRejectedValueOnce(new Error("Resend: not_authorized"))
    const { scope } = makeScope()
    const res = makeRes()

    await SEND(makeReq({ scope, body: { template: "order-placed" } }), res)

    expect(res.statusCode).toBe(500)
    expect(res.body.message).toBe("E-mail versturen mislukt.")
  })
})

// The composer's shipped-mail button posts HERE, not to email/send, so the
// order still transitions to shipped when an edited tracking mail goes out.
describe("POST /admin/orders/:id/dhl-label/send-email with edited copy", () => {
  it("validates the overrides and hands them to the shipped-mail helper", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND_SHIPPED(
      makeReq({
        scope,
        body: {
          resend: true,
          overrides: {
            body: "Wij hebben uw pakket vanmiddag afgegeven bij DHL.",
            trackingUrl: "https://example.com/anders",
          },
        },
      }),
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ sent: true, edited: true })
    expect(sendOrderShippedNotification).toHaveBeenCalledWith(
      scope,
      FULFILLMENT_ID,
      expect.objectContaining({
        orderId: ORDER_ID,
        forceResend: true,
        overrides: {
          body: "Wij hebben uw pakket vanmiddag afgegeven bij DHL.",
          trackingUrl: "https://example.com/anders",
        },
      })
    )
  })

  it("400s on invalid overrides and never marks the order shipped", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND_SHIPPED(
      makeReq({ scope, body: { resend: true, overrides: { trackingUrl: "/relatief" } } }),
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe("Controleer de ingevulde velden")
    expect(res.body.errors.join(" ")).toContain("Tracking-link")
    expect(sendOrderShippedNotification).not.toHaveBeenCalled()
  })

  it("keeps working unchanged for a plain one-click send", async () => {
    const { scope } = makeScope()
    const res = makeRes()

    await SEND_SHIPPED(makeReq({ scope, body: {} }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.edited).toBe(false)
    const opts = sendOrderShippedNotification.mock.calls[0][2]
    expect(opts.forceResend).toBe(false)
    expect("overrides" in opts).toBe(false)
  })
})

// The preview and the send path must build their payload the same way, or the
// operator proofreads one email and the customer gets another.
describe("preview and send agree", () => {
  it("previews exactly the copy the send path stores", async () => {
    const overrides = {
      subject: "Uw bestelling bij ons",
      heading: "Dank voor uw order",
      body: "Wij pakken uw bestelling morgen in.",
    }

    const previewRes = makeRes()
    await PREVIEW(
      makeReq({ scope: makeScope().scope, body: { template: "order-placed", overrides } }),
      previewRes
    )

    const sendRes = makeRes()
    await SEND(
      makeReq({ scope: makeScope().scope, body: { template: "order-placed", overrides } }),
      sendRes
    )

    const sentData = sendEmailNotification.mock.calls[0][1].data
    expect(previewRes.body.subject).toBe(sentData.emailOptions.subject)
    expect(previewRes.body.html).toContain("Dank voor uw order")
    expect(previewRes.body.html).toContain("Wij pakken uw bestelling morgen in.")
    expect(sentData.overrides).toEqual({
      heading: "Dank voor uw order",
      body: "Wij pakken uw bestelling morgen in.",
    })
  })
})
