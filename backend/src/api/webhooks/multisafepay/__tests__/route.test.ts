import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

jest.mock("@medusajs/framework/utils", () => ({
  Modules: {
    PAYMENT: "paymentModuleService",
    NOTIFICATION: "notificationModuleService",
    EVENT_BUS: "eventBusModuleService",
  },
  ContainerRegistrationKeys: { QUERY: "query" },
}))

jest.mock("../../../../lib/instrument", () => ({
  Sentry: {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
  },
}))

jest.mock("../../../../modules/payment-multisafepay/client", () => ({
  MultisafepayClient: jest.fn().mockImplementation(() => ({
    getOrder: jest.fn().mockResolvedValue(null),
  })),
}))

// Avoid pulling react-email through email-notifications/templates,
// which trips Jest's moduleNameMapper inside htmlparser2.
jest.mock("../../../../modules/email-notifications/templates", () => ({
  EmailTemplates: { ABANDONED_CART_PAID: "abandoned-cart-paid" },
}))

import { POST } from "../route"

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}

function mockRequest(paymentModule: unknown, body: unknown = {}) {
  return {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: {},
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "logger") return mockLogger
        if (key === "paymentModuleService") return paymentModule
        return undefined
      }),
    },
  } as unknown as MedusaRequest
}

function mockResponse() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.type = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res as MedusaResponse & {
    status: jest.Mock
    type: jest.Mock
    send: jest.Mock
  }
}

describe("POST /webhooks/multisafepay", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("calls getWebhookActionAndData with the bare provider id (no pp_ prefix)", async () => {
    // Regression: Medusa's payment module prepends `pp_` to `provider`
    // (payment-module.js: `const providerId = pp_${eventData.provider}`).
    // Passing the already-prefixed id produced `pp_pp_multisafepay_multisafepay`
    // and threw "Unable to retrieve the payment provider" on every webhook.
    const paymentModule = {
      getWebhookActionAndData: jest.fn().mockResolvedValue(undefined),
    }
    const req = mockRequest(paymentModule)
    const res = mockResponse()

    await POST(req, res)

    expect(paymentModule.getWebhookActionAndData).toHaveBeenCalledTimes(1)
    const arg = paymentModule.getWebhookActionAndData.mock.calls[0][0]
    expect(arg.provider).toBe("multisafepay_multisafepay")
    expect(arg.provider).not.toMatch(/^pp_/)
  })

  it("acks 200 OK even when getWebhookActionAndData throws", async () => {
    const paymentModule = {
      getWebhookActionAndData: jest
        .fn()
        .mockRejectedValue(new Error("provider lookup failed")),
    }
    const req = mockRequest(paymentModule)
    const res = mockResponse()

    await POST(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith("OK")
  })
})
