import crypto from "node:crypto"

// `@medusajs/framework/utils` pulls in bignumber.js whose import name trips
// the repo-wide Jest moduleNameMapper. Mock just the surface client.ts needs
// so these tests can run in isolation.
jest.mock("@medusajs/framework/utils", () => {
  class MedusaError extends Error {
    static Types = {
      INVALID_DATA: "INVALID_DATA",
      UNEXPECTED_STATE: "UNEXPECTED_STATE",
      NOT_FOUND: "NOT_FOUND",
      NOT_ALLOWED: "NOT_ALLOWED",
      UNAUTHORIZED: "UNAUTHORIZED",
    }
    public type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  }
  return { MedusaError }
})

import { MultisafepayClient } from "../client"

const API_KEY = "test_api_key_123"
const SAMPLE_BODY = '{"order_id":"inovix_abc","status":"completed","amount":1999}'

function signWebhook(timestamp: number, body: string, key = API_KEY): string {
  const sig = crypto
    .createHmac("sha512", key)
    .update(`${timestamp}:${body}`)
    .digest("hex")
  return Buffer.from(`${timestamp}:${sig}`, "utf8").toString("base64")
}

describe("MultisafepayClient.verifyWebhookSignature", () => {
  const client = new MultisafepayClient({ apiKey: API_KEY, environment: "test" })
  const now = 1_700_000_000

  it("accepts a valid signature within the tolerance window", () => {
    const auth = signWebhook(now, SAMPLE_BODY)
    expect(
      client.verifyWebhookSignature({
        authHeader: auth,
        rawBody: SAMPLE_BODY,
        nowUnix: now + 30,
      })
    ).toEqual({ ok: true })
  })

  it("rejects when the Auth header is missing", () => {
    const result = client.verifyWebhookSignature({
      authHeader: undefined,
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/missing/i)
  })

  it("rejects when the Auth header is not valid base64-encoded payload", () => {
    const result = client.verifyWebhookSignature({
      authHeader: "!!! not base64 !!!",
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/malformed|base64/i)
  })

  it("rejects when timestamp is older than the tolerance window", () => {
    const auth = signWebhook(now - 10_000, SAMPLE_BODY)
    const result = client.verifyWebhookSignature({
      authHeader: auth,
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/tolerance/i)
  })

  it("rejects when the body has been tampered with", () => {
    const auth = signWebhook(now, SAMPLE_BODY)
    const result = client.verifyWebhookSignature({
      authHeader: auth,
      rawBody: SAMPLE_BODY.replace("1999", "9999"),
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/signature/i)
  })

  it("rejects when the signature was generated with a different key", () => {
    const auth = signWebhook(now, SAMPLE_BODY, "other_key")
    const result = client.verifyWebhookSignature({
      authHeader: auth,
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/signature/i)
  })

  it("rejects when the timestamp portion is non-numeric", () => {
    const fake = Buffer.from(`abc:deadbeef`, "utf8").toString("base64")
    const result = client.verifyWebhookSignature({
      authHeader: fake,
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/timestamp/i)
  })

  it("respects a custom tolerance setting", () => {
    const tightClient = new MultisafepayClient({
      apiKey: API_KEY,
      environment: "test",
      webhookTimestampToleranceSeconds: 10,
    })
    const auth = signWebhook(now - 60, SAMPLE_BODY)
    const result = tightClient.verifyWebhookSignature({
      authHeader: auth,
      rawBody: SAMPLE_BODY,
      nowUnix: now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/tolerance/i)
  })
})

describe("MultisafepayClient HTTP layer", () => {
  const originalFetch = global.fetch
  let mockFetch: jest.Mock

  beforeEach(() => {
    mockFetch = jest.fn()
    global.fetch = mockFetch as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  it("sends api_key as a query parameter and POSTs JSON for createOrder", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { order_id: "inovix_abc", payment_url: "https://payv2.multisafepay.com/abc" },
      })
    )

    const client = new MultisafepayClient({
      apiKey: API_KEY,
      environment: "test",
    })

    const result = await client.createOrder({
      orderId: "inovix_abc",
      amountCents: 1999,
      currencyCode: "eur",
      notificationUrl: "https://example.com/webhook",
      redirectUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    })

    expect(result).toEqual({
      orderId: "inovix_abc",
      paymentUrl: "https://payv2.multisafepay.com/abc",
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/testapi\.multisafepay\.com\/v1\/json\/orders\?api_key=test_api_key_123$/)
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      type: "redirect",
      order_id: "inovix_abc",
      currency: "EUR",
      amount: 1999,
      payment_options: {
        notification_url: "https://example.com/webhook",
        notification_method: "POST",
        redirect_url: "https://example.com/return",
        cancel_url: "https://example.com/cancel",
      },
    })
  })

  it("forwards Idempotency-Key when provided", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { order_id: "inovix_xyz", payment_url: "https://x" },
      })
    )

    const client = new MultisafepayClient({ apiKey: API_KEY, environment: "test" })
    await client.createOrder({
      orderId: "inovix_xyz",
      amountCents: 1,
      currencyCode: "EUR",
      idempotencyKey: "idem-abc",
    })

    const [, init] = mockFetch.mock.calls[0]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.get("Idempotency-Key")).toBe("idem-abc")
  })

  it("normalises GET /orders/{id} into a MultisafepayOrder", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          order_id: "inovix_abc",
          status: "completed",
          amount: 1999,
          currency: "eur",
          transaction_id: 4242,
          customer: { email: "a@b.test", first_name: "Jane", last_name: "Doe" },
          payment_details: { type: "IDEAL" },
        },
      })
    )

    const client = new MultisafepayClient({ apiKey: API_KEY, environment: "test" })
    const order = await client.getOrder("inovix_abc")

    expect(order).toMatchObject({
      orderId: "inovix_abc",
      status: "completed",
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: "4242",
      customerEmail: "a@b.test",
      customerFullName: "Jane Doe",
      paymentMethod: "IDEAL",
    })
  })

  it("raises a MedusaError without leaking the api_key when MSP returns success=false", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        { success: false, error_code: 1006, error_info: "Invalid api_key" },
        400
      )
    )
    const client = new MultisafepayClient({ apiKey: API_KEY, environment: "test" })

    await expect(client.getOrder("missing")).rejects.toThrow(
      /1006|Invalid api_key/
    )
    await expect(client.getOrder("missing")).rejects.not.toThrow(
      new RegExp(API_KEY)
    )
  })
})
