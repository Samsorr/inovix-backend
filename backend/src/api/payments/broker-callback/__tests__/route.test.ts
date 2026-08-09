import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

// Use the real PaymentActions string values so the route's comparisons
// behave exactly like production.
jest.mock("@medusajs/framework/utils", () => ({
  Modules: { PAYMENT: "paymentModule", WORKFLOW_ENGINE: "workflowEngine" },
  PaymentActions: {
    SUCCESSFUL: "captured",
    AUTHORIZED: "authorized",
    CANCELED: "canceled",
    FAILED: "failed",
    NOT_SUPPORTED: "not_supported",
    PENDING: "pending",
    REQUIRES_MORE: "requires_more",
  },
}))

jest.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflowId: "process-payment-workflow",
}))

import { POST } from "../route"

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }

// The broker knows its own opaque ref (`pay_<hex>`), never Medusa's session id,
// so the route has to translate. Default double: one live session carrying the
// ref the fixtures below use.
const SESSIONS = [
  { id: "payses_other", data: { ref: "pay_zzz", cart_id: "cart_zzz" } },
  { id: "payses_01ABC", data: { ref: "pay_abc", cart_id: "cart_abc" } },
]

function mockRequest(input: {
  webhookResult?: unknown
  webhookError?: Error
  workflowError?: Error
  sessions?: Array<{ id: string; data?: Record<string, unknown> | null }>
}) {
  const getWebhookActionAndData = input.webhookError
    ? jest.fn().mockRejectedValue(input.webhookError)
    : jest.fn().mockResolvedValue(input.webhookResult)
  const listPaymentSessions = jest.fn().mockResolvedValue(input.sessions ?? SESSIONS)
  const run = input.workflowError
    ? jest.fn().mockRejectedValue(input.workflowError)
    : jest.fn().mockResolvedValue({})
  const req = {
    body: { ref: "pay_abc", status: "captured" },
    rawBody: Buffer.from(JSON.stringify({ ref: "pay_abc", status: "captured" })),
    headers: { "x-signature": "sig", "x-timestamp": "123" },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "logger") return mockLogger
        if (key === "paymentModule") return { getWebhookActionAndData, listPaymentSessions }
        if (key === "workflowEngine") return { run }
        return undefined
      }),
    },
  } as unknown as MedusaRequest
  return { req, getWebhookActionAndData, listPaymentSessions, run }
}

function mockResponse() {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn().mockReturnValue(res)
  res.type = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res as unknown as MedusaResponse & {
    status: jest.Mock
    send: jest.Mock
  }
}

describe("POST /payments/broker-callback", () => {
  beforeEach(() => jest.clearAllMocks())

  // processPaymentWorkflow looks up `payment_session` BY ID and walks
  // payment_collection -> cart to complete it. Handing it the broker ref made
  // every lookup miss and threw "PaymentSession with id: pay_... was not found"
  // (prod, order #28416, 2026-08-08), so the cron had to rescue the order.
  test("captured action swaps the broker ref for the Medusa payment session id", async () => {
    const event = {
      action: "captured",
      data: { session_id: "pay_abc", amount: undefined },
    }
    const { req, run, listPaymentSessions } = mockRequest({ webhookResult: event })
    const res = mockResponse()

    await POST(req, res)

    expect(listPaymentSessions).toHaveBeenCalledWith(
      { provider_id: "pp_via_broker_via_broker" },
      expect.objectContaining({ order: { created_at: "DESC" } })
    )
    expect(run).toHaveBeenCalledWith("process-payment-workflow", {
      input: { action: "captured", data: { session_id: "payses_01ABC", amount: undefined } },
    })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test("authorized action also runs the workflow, with the mapped session id", async () => {
    const event = {
      action: "authorized",
      data: { session_id: "pay_abc", amount: undefined },
    }
    const { req, run } = mockRequest({ webhookResult: event })
    const res = mockResponse()

    await POST(req, res)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1].input.data.session_id).toBe("payses_01ABC")
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test("unknown ref is acknowledged without running the workflow (cron picks it up)", async () => {
    const { req, run } = mockRequest({
      webhookResult: { action: "captured", data: { session_id: "pay_gone" } },
    })
    const res = mockResponse()

    await POST(req, res)

    expect(run).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("pay_gone"))
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test("sessions with no data do not break the ref lookup", async () => {
    const { req, run } = mockRequest({
      webhookResult: { action: "captured", data: { session_id: "pay_abc" } },
      sessions: [
        { id: "payses_null", data: null },
        { id: "payses_01ABC", data: { ref: "pay_abc" } },
      ],
    })
    const res = mockResponse()

    await POST(req, res)

    expect(run.mock.calls[0][1].input.data.session_id).toBe("payses_01ABC")
  })

  test.each(["failed", "canceled", "not_supported", "requires_more"])(
    "%s action is acknowledged without running the workflow",
    async (action) => {
      const { req, run } = mockRequest({
        webhookResult: { action, data: { session_id: "pay_abc" } },
      })
      const res = mockResponse()

      await POST(req, res)

      expect(run).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(200)
    }
  )

  test("missing event data is acknowledged without running the workflow", async () => {
    const { req, run } = mockRequest({
      webhookResult: { action: "captured", data: undefined },
    })
    const res = mockResponse()

    await POST(req, res)

    expect(run).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test("getWebhookActionAndData failure still acks 200 and logs", async () => {
    const { req, run } = mockRequest({ webhookError: new Error("boom") })
    const res = mockResponse()

    await POST(req, res)

    expect(run).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test("workflow failure still acks 200 and logs (reconcile cron is the net)", async () => {
    const { req } = mockRequest({
      webhookResult: {
        action: "captured",
        data: { session_id: "pay_abc", amount: undefined },
      },
      workflowError: new Error("workflow exploded"),
    })
    const res = mockResponse()

    await POST(req, res)

    expect(mockLogger.error).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
