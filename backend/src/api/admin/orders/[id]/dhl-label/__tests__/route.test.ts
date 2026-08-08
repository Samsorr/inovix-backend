jest.mock("../../../../../../lib/dhl-label", () => ({
  createDhlLabelForOrder: jest.fn(),
}))

import { POST } from "../route"
import { createDhlLabelForOrder } from "../../../../../../lib/dhl-label"

function makeRes() {
  const res: any = { statusCode: 0, body: undefined }
  res.status = (c: number) => ((res.statusCode = c), res)
  res.json = (b: unknown) => ((res.body = b), res)
  return res
}

const req: any = { params: { id: "order_1" }, scope: {} }

beforeEach(() => {
  ;(createDhlLabelForOrder as jest.Mock).mockReset()
})

describe("POST /admin/orders/:id/dhl-label failures", () => {
  it("answers with the real cause in Dutch instead of one generic sentence", async () => {
    // DhlParcelApiError extends Error, not MedusaError, so every DHL API
    // failure arrives here as { status: "error" }.
    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({
      status: "error",
      message: "DHL Parcel POST /labels failed with 401 after re-auth",
    })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body.message).not.toBe("DHL label creation failed")
    expect(res.body.message).toContain("beheerder")
    expect(res.body.code).toBe("dhl_auth")
    // The technical cause survives for escalation.
    expect(res.body.details).toContain("401")
  })

  it("distinguishes the DHL failure modes from each other", async () => {
    const cases = [
      ["DHL Parcel POST /labels failed with 400", "dhl_rejected"],
      ["DHL Parcel POST /labels failed with 502 after retry", "dhl_unavailable"],
      ["fetch failed", "no_connection"],
      ["Cannot compute shipment weight: an order item is missing a product weight", "missing_weight"],
      ["No DHL Parcel box presets configured", "no_box_presets"],
    ] as const
    const messages: string[] = []

    for (const [message, code] of cases) {
      ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({ status: "error", message })
      const res = makeRes()
      await POST(req, res)
      expect(res.body.code).toBe(code)
      messages.push(res.body.message)
    }

    expect(new Set(messages).size).toBe(cases.length)
  })

  it("maps a MedusaError validation failure to Dutch and keeps its status", async () => {
    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({
      status: "invalid",
      httpStatus: 400,
      message: "Order has no DHL Parcel shipping method",
      details: "invalid_data",
    })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toContain("DHL-verzendmethode")
    expect(res.body.code).toBe("no_shipping_method")
    expect(res.body.error_type).toBe("invalid_data")
  })

  it("does not echo a credential back into the admin", async () => {
    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({
      status: "error",
      message: 'DHL Parcel auth failed: {"client_secret":"s3cr3t-value-here"}',
    })
    const res = makeRes()

    await POST(req, res)

    expect(JSON.stringify(res.body)).not.toContain("s3cr3t-value-here")
    expect(res.body.details).toContain("[verwijderd]")
  })

  it("answers Dutch for a missing order and for a blocked checklist", async () => {
    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({ status: "not_found" })
    const missing = makeRes()
    await POST(req, missing)
    expect(missing.statusCode).toBe(404)
    expect(missing.body.message).toContain("niet gevonden")

    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({
      status: "checklist_blocked",
      order_id: "order_1",
      display_id: 28411,
      ticked: 1,
      total: 3,
    })
    const blocked = makeRes()
    await POST(req, blocked)
    expect(blocked.statusCode).toBe(400)
    expect(blocked.body.message).toContain("afgevinkt")
  })

  it("still returns the created label unchanged", async () => {
    ;(createDhlLabelForOrder as jest.Mock).mockResolvedValue({
      status: "created",
      fulfillment_id: "ful_1",
      display_id: 28411,
      tracking_number: "3STOTA123",
      label_pdf_url: "data:application/pdf;base64,AAA",
      shipment_tracking_url: "https://dhl.example/track",
    })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(201)
    expect(res.body.tracking_number).toBe("3STOTA123")
  })
})
