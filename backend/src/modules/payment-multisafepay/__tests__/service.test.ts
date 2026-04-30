import crypto from "node:crypto"

// Mock the framework surface the service needs. The real package pulls in the
// full Medusa module graph (and bignumber.js) which trips the repo-wide Jest
// moduleNameMapper, so we provide minimal stand-ins.
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

  abstract class AbstractPaymentProvider<T> {
    static identifier: string
    constructor(_container: unknown, _options: T) {}
  }

  class BigNumber {
    constructor(public readonly numeric: number) {}
  }

  return { MedusaError, AbstractPaymentProvider, BigNumber }
})

import MultisafepayPaymentProviderService from "../service"

type Mocked<T> = { [K in keyof T]: jest.Mock }

function makeService(opts?: Partial<{ webhookTimestampToleranceSeconds: number }>) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new MultisafepayPaymentProviderService(
    { logger } as any,
    {
      apiKey: "test_api_key_123",
      environment: "test",
      ...(opts ?? {}),
    }
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (service as any).client_ as Mocked<{
    createOrder: jest.Mock
    getOrder: jest.Mock
    cancelOrder: jest.Mock
    verifyWebhookSignature: jest.Mock
  }>
  client.createOrder = jest.fn()
  client.getOrder = jest.fn()
  client.cancelOrder = jest.fn()
  client.verifyWebhookSignature = jest.fn().mockReturnValue({ ok: true })

  return { service, client, logger }
}

describe("MultisafepayPaymentProviderService.validateOptions", () => {
  it("rejects when apiKey is missing", () => {
    expect(() =>
      MultisafepayPaymentProviderService.validateOptions({})
    ).toThrow(/apiKey/)
  })

  it("accepts when apiKey is provided", () => {
    expect(() =>
      MultisafepayPaymentProviderService.validateOptions({ apiKey: "x" })
    ).not.toThrow()
  })
})

describe("initiatePayment", () => {
  beforeEach(() => {
    process.env.STOREFRONT_URL = "https://shop.test"
    process.env.BACKEND_PUBLIC_URL = "https://api.test"
  })

  it("creates an MSP order with a fresh order_id and stores payment_url in session data", async () => {
    const { service, client } = makeService()
    client.createOrder.mockResolvedValue({
      orderId: "inovix_abc",
      paymentUrl: "https://payv2.multisafepay.com/abc",
    })

    const result = await service.initiatePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount: 1999 as any,
      currency_code: "EUR",
      context: {
        idempotency_key: "idem-1",
        customer: {
          email: "buyer@example.com",
          first_name: "Jan",
          last_name: "de Vries",
          billing_address: { country_code: "nl" },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })

    expect(client.createOrder).toHaveBeenCalledTimes(1)
    const callArg = client.createOrder.mock.calls[0][0]
    expect(callArg.amountCents).toBe(1999)
    expect(callArg.currencyCode).toBe("EUR")
    expect(callArg.orderId).toMatch(/^inovix_/)
    expect(callArg.notificationUrl).toBe(
      "https://api.test/webhooks/multisafepay"
    )
    expect(callArg.redirectUrl).toBe(
      "https://shop.test/checkout/multisafepay-return"
    )
    expect(callArg.cancelUrl).toBe(
      "https://shop.test/checkout?msp=cancelled"
    )
    expect(callArg.customer?.country).toBe("NL")
    expect(callArg.idempotencyKey).toBe("idem-1")

    expect(result.id).toBe("inovix_abc")
    expect(result.data).toMatchObject({
      mspOrderId: "inovix_abc",
      paymentUrl: "https://payv2.multisafepay.com/abc",
      amount: 1999,
      currency: "EUR",
    })
  })
})

describe("authorizePayment", () => {
  it("returns pending if mspOrderId is not yet on the session", async () => {
    const { service } = makeService()
    const result = await service.authorizePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {} as any,
      context: { idempotency_key: "x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(result.status).toBe("pending")
  })

  it("returns captured when MSP order status is completed and amount matches", async () => {
    const { service, client } = makeService()
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: "completed",
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: "4242",
    })

    const result = await service.authorizePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { mspOrderId: "inovix_abc", amount: 1999 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(result.status).toBe("captured")
    expect((result.data as { transactionId?: string }).transactionId).toBe("4242")
  })

  it("rejects with canceled when amount drift exceeds 1 cent", async () => {
    const { service, client, logger } = makeService()
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: "completed",
      amountCents: 9999,
      currencyCode: "EUR",
      transactionId: "1",
    })

    const result = await service.authorizePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { mspOrderId: "inovix_abc", amount: 1999 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(result.status).toBe("canceled")
    expect(logger.warn).toHaveBeenCalled()
  })

  it("rejects with canceled when stored transactionId does not match MSP", async () => {
    const { service, client, logger } = makeService()
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: "completed",
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: "9999",
    })

    const result = await service.authorizePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        mspOrderId: "inovix_abc",
        amount: 1999,
        transactionId: "1",
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(result.status).toBe("canceled")
    expect(logger.warn).toHaveBeenCalled()
  })

  it.each([
    ["declined", "canceled"],
    ["expired", "canceled"],
    ["cancelled", "canceled"],
    ["uncleared", "authorized"],
    ["initialized", "pending"],
  ])("maps MSP status %s -> %s", async (mspStatus, expected) => {
    const { service, client } = makeService()
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: mspStatus,
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: null,
    })

    const result = await service.authorizePayment({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { mspOrderId: "inovix_abc", amount: 1999 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(result.status).toBe(expected)
  })
})

describe("getWebhookActionAndData", () => {
  function signedWebhook(body: string, apiKey = "test_api_key_123") {
    const ts = Math.floor(Date.now() / 1000)
    const sig = crypto.createHmac("sha512", apiKey).update(`${ts}:${body}`).digest("hex")
    const auth = Buffer.from(`${ts}:${sig}`, "utf8").toString("base64")
    return { auth, ts }
  }

  it("returns captured for a verified completed webhook", async () => {
    const { service, client } = makeService()
    const body = JSON.stringify({
      order_id: "inovix_abc",
      status: "completed",
      amount: 1999,
    })
    const { auth } = signedWebhook(body)

    client.verifyWebhookSignature.mockReturnValue({ ok: true })
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: "completed",
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: "4242",
    })

    const result = await service.getWebhookActionAndData({
      data: JSON.parse(body),
      rawData: Buffer.from(body, "utf8"),
      headers: { auth },
    })

    expect(result.action).toBe("captured")
    expect(result.data.session_id).toBe("inovix_abc")
  })

  it("returns failed for declined orders", async () => {
    const { service, client } = makeService()
    const body = JSON.stringify({ order_id: "inovix_abc" })
    const { auth } = signedWebhook(body)
    client.verifyWebhookSignature.mockReturnValue({ ok: true })
    client.getOrder.mockResolvedValue({
      orderId: "inovix_abc",
      status: "declined",
      amountCents: 1999,
      currencyCode: "EUR",
      transactionId: null,
    })

    const result = await service.getWebhookActionAndData({
      data: JSON.parse(body),
      rawData: Buffer.from(body, "utf8"),
      headers: { auth },
    })
    expect(result.action).toBe("failed")
  })

  it("returns not_supported when signature verification fails", async () => {
    const { service, client, logger } = makeService()
    client.verifyWebhookSignature.mockReturnValue({ ok: false, reason: "boom" })

    const body = JSON.stringify({ order_id: "inovix_abc" })
    const result = await service.getWebhookActionAndData({
      data: JSON.parse(body),
      rawData: Buffer.from(body, "utf8"),
      headers: { auth: "bad" },
    })
    expect(result.action).toBe("not_supported")
    expect(logger.warn).toHaveBeenCalled()
    expect(client.getOrder).not.toHaveBeenCalled()
  })

  it("returns not_supported when raw body is missing", async () => {
    const { service, client } = makeService()
    const result = await service.getWebhookActionAndData({
      data: { order_id: "inovix_abc" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rawData: undefined as any,
      headers: { auth: "x" },
    })
    expect(result.action).toBe("not_supported")
    expect(client.verifyWebhookSignature).not.toHaveBeenCalled()
  })

  it("refundPayment surfaces a clear error", async () => {
    const { service } = makeService()
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.refundPayment({ data: {}, amount: 1 as any } as any)
    ).rejects.toThrow(/dashboard/i)
  })
})
