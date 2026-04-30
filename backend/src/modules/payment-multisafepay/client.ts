import crypto from "node:crypto"

import { MedusaError } from "@medusajs/framework/utils"

import type {
  CreateOrderInput,
  CreateOrderResult,
  MultisafepayEnvironment,
  MultisafepayOptions,
  MultisafepayOrder,
  MultisafepayStatus,
} from "./types"

const ENDPOINTS: Record<MultisafepayEnvironment, string> = {
  production: "https://api.multisafepay.com/v1/json",
  test: "https://testapi.multisafepay.com/v1/json",
}

const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300

type RawApiResponse<T> = {
  success?: boolean
  data?: T
  error_code?: number
  error_info?: string
}

type RawOrder = {
  order_id?: string
  status?: MultisafepayStatus
  amount?: number
  currency?: string
  transaction_id?: string | number
  payment_url?: string
  customer?: {
    email?: string
    first_name?: string
    last_name?: string
  }
  payment_details?: {
    type?: string
  }
}

export class MultisafepayClient {
  private readonly options: MultisafepayOptions
  private readonly baseUrl: string
  private readonly tolerance: number

  constructor(options: MultisafepayOptions) {
    if (!options.apiKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MultiSafepay client requires an apiKey"
      )
    }
    this.options = options
    this.baseUrl = ENDPOINTS[options.environment ?? "production"]
    this.tolerance =
      options.webhookTimestampToleranceSeconds ??
      DEFAULT_WEBHOOK_TOLERANCE_SECONDS
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const body: Record<string, unknown> = {
      type: "redirect",
      order_id: input.orderId,
      currency: input.currencyCode.toUpperCase(),
      amount: input.amountCents,
      description: input.description ?? `Order ${input.orderId}`,
      payment_options: {
        notification_url: input.notificationUrl,
        notification_method: "POST",
        redirect_url: input.redirectUrl,
        cancel_url: input.cancelUrl,
        close_window: true,
      },
    }

    if (input.customer) {
      body.customer = {
        email: input.customer.email,
        first_name: input.customer.firstName,
        last_name: input.customer.lastName,
        address1: input.customer.address1,
        house_number: input.customer.houseNumber,
        zip_code: input.customer.zipCode,
        city: input.customer.city,
        country: input.customer.country,
        phone: input.customer.phone,
        locale: input.customer.locale ?? "nl_NL",
      }
    }

    const data = await this.fetchJson<RawOrder>("/orders", {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey: input.idempotencyKey,
    })

    if (!data.order_id || !data.payment_url) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "MultiSafepay createOrder: response missing order_id or payment_url"
      )
    }

    return { orderId: data.order_id, paymentUrl: data.payment_url }
  }

  async getOrder(orderId: string): Promise<MultisafepayOrder> {
    const data = await this.fetchJson<RawOrder>(
      `/orders/${encodeURIComponent(orderId)}`,
      { method: "GET" }
    )
    return this.normaliseOrder(data, orderId)
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.fetchJson<unknown>(
      `/orders/${encodeURIComponent(orderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      }
    ).catch((err) => {
      // 404 means the order has already been consumed or expired | benign
      // for the cleanup path. Anything else still surfaces.
      const msg = (err as Error).message ?? ""
      if (!/\b404\b/.test(msg)) throw err
    })
  }

  // Verifies a MultiSafepay POST webhook using the Auth header.
  //
  // Algorithm (https://docs.multisafepay.com/docs/webhook):
  //   1. base64 decode the Auth header
  //   2. split on ':' | first part is unix timestamp, second is hex SHA512
  //   3. recompute HMAC-SHA512(apiKey, `${timestamp}:${rawBody}`)
  //   4. constant-time compare against the supplied signature
  //   5. reject if the timestamp is outside the configured tolerance window
  //
  // rawBody MUST be the exact bytes received | re-stringifying parsed JSON
  // will produce a different signature.
  verifyWebhookSignature(input: {
    authHeader: string | undefined | null
    rawBody: string
    nowUnix?: number
  }): { ok: true } | { ok: false; reason: string } {
    const auth = (input.authHeader ?? "").trim()
    if (!auth) return { ok: false, reason: "missing Auth header" }

    let decoded: string
    try {
      decoded = Buffer.from(auth, "base64").toString("utf8")
    } catch {
      return { ok: false, reason: "Auth header is not valid base64" }
    }

    const sep = decoded.indexOf(":")
    if (sep <= 0 || sep === decoded.length - 1) {
      return { ok: false, reason: "Auth header is malformed" }
    }
    const timestampStr = decoded.slice(0, sep)
    const signatureHex = decoded.slice(sep + 1).trim()
    const timestamp = Number(timestampStr)
    if (!Number.isFinite(timestamp)) {
      return { ok: false, reason: "Auth header timestamp is not a number" }
    }

    const now = input.nowUnix ?? Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestamp) > this.tolerance) {
      return { ok: false, reason: "Auth header timestamp out of tolerance" }
    }

    const expected = crypto
      .createHmac("sha512", this.options.apiKey)
      .update(`${timestampStr}:${input.rawBody}`)
      .digest("hex")

    const a = Buffer.from(expected, "utf8")
    const b = Buffer.from(signatureHex, "utf8")
    if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" }
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "signature mismatch" }
    }

    return { ok: true }
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string }
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    url.searchParams.set("api_key", this.options.apiKey)

    const headers = new Headers(init.headers)
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json")
    }
    if (init.idempotencyKey) {
      headers.set("Idempotency-Key", init.idempotencyKey)
    }

    const res = await fetch(url.toString(), { ...init, headers })
    const text = await res.text()
    let parsed: RawApiResponse<T> | undefined
    try {
      parsed = text ? (JSON.parse(text) as RawApiResponse<T>) : undefined
    } catch {
      parsed = undefined
    }

    if (!res.ok || parsed?.success === false) {
      // Strip the api_key from any echoed URL before raising | senior-dev
      // habit: never let credentials end up in logs or Sentry breadcrumbs.
      const safeUrl = `${this.baseUrl}${path}`
      const code = parsed?.error_code ?? res.status
      const info = parsed?.error_info ?? text.slice(0, 500)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `MultiSafepay ${init.method ?? "GET"} ${safeUrl} failed: ${code} ${info}`
      )
    }

    if (!parsed?.data) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `MultiSafepay ${init.method ?? "GET"} ${path}: empty data`
      )
    }
    return parsed.data
  }

  private normaliseOrder(data: RawOrder, fallbackOrderId: string): MultisafepayOrder {
    const status = data.status ?? "initialized"
    const amountRaw = typeof data.amount === "number" ? data.amount : 0
    return {
      orderId: data.order_id ?? fallbackOrderId,
      status,
      amountCents: Math.round(amountRaw),
      currencyCode: (data.currency ?? "EUR").toUpperCase(),
      transactionId:
        data.transaction_id !== undefined && data.transaction_id !== null
          ? String(data.transaction_id)
          : null,
      paymentUrl: data.payment_url ?? null,
      customerEmail: data.customer?.email ?? null,
      customerFullName: [data.customer?.first_name, data.customer?.last_name]
        .filter(Boolean)
        .join(" ") || null,
      paymentMethod: data.payment_details?.type ?? null,
    }
  }
}
