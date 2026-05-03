import crypto from "node:crypto"

import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
} from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"

import { MultisafepayClient } from "./client"
import type {
  MultisafepayOptions,
  MultisafepayOrder,
  MultisafepayStatus,
  MultisafepayWebhookPayload,
} from "./types"

type InjectedDependencies = {
  logger: Logger
}

type SessionData = {
  // The order_id we send to MultiSafepay. Acts as the round-trip identifier
  // between our payment session and the MSP order; unique per initiation.
  mspOrderId?: string
  paymentUrl?: string
  // transaction_id from MultiSafepay; populated once payment is created.
  transactionId?: string
  status?: MultisafepayStatus
  amount?: number
  currency?: string
}

// Currencies that don't follow the default 2-decimal cents model. These
// affect the smallest-unit conversion: zero-decimal currencies are billed
// as whole units, three-decimal currencies as thousandths.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
])
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "OMR", "TND",
])

function decimalsForCurrency(currencyCode: string): number {
  const upper = currencyCode.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 3
  return 2
}

const PAID_STATUSES: MultisafepayStatus[] = ["completed"]
const AUTHORIZED_STATUSES: MultisafepayStatus[] = ["uncleared", "reserved"]
const FAILED_STATUSES: MultisafepayStatus[] = [
  "declined",
  "expired",
  "cancelled",
  "void",
  "chargedback",
]
const REFUNDED_STATUSES: MultisafepayStatus[] = ["refunded", "partial_refunded"]

class MultisafepayPaymentProviderService extends AbstractPaymentProvider<MultisafepayOptions> {
  static identifier = "multisafepay"

  protected readonly logger_: Logger
  protected readonly options_: MultisafepayOptions
  protected readonly client_: MultisafepayClient

  constructor(container: InjectedDependencies, options: MultisafepayOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new MultisafepayClient(options)
  }

  static validateOptions(options: Record<string, unknown>) {
    if (!options.apiKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MultiSafepay: missing required option 'apiKey'"
      )
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const amountCents = this.toSmallestUnit(input.amount, input.currency_code)

    const customerCtx = input.context?.customer as
      | {
          email?: string | null
          first_name?: string | null
          last_name?: string | null
          phone?: string | null
          billing_address?: {
            address_1?: string | null
            postal_code?: string | null
            city?: string | null
            country_code?: string | null
            phone?: string | null
          } | null
        }
      | undefined

    const billing = customerCtx?.billing_address
    const country = billing?.country_code
      ? billing.country_code.toUpperCase()
      : undefined

    const backendUrl =
      process.env.BACKEND_PUBLIC_URL ?? process.env.BACKEND_URL
    const storefrontUrl = process.env.STOREFRONT_URL
    const notificationUrl = backendUrl
      ? `${backendUrl.replace(/\/$/, "")}/webhooks/multisafepay`
      : undefined
    const redirectUrl = storefrontUrl
      ? `${storefrontUrl.replace(/\/$/, "")}/checkout/multisafepay-return`
      : undefined
    const cancelUrl = storefrontUrl
      ? `${storefrontUrl.replace(/\/$/, "")}/checkout?msp=cancelled`
      : undefined

    // The order_id and description below are visible to the customer on
    // MultiSafepay's hosted payment page, in MSP receipt emails, and in any
    // "what was this charge?" lookup. They use Tencore-aligned wording so
    // the customer's experience matches the merchant of record (Tencore)
    // they see on their bank statement.
    const mspOrderId = `tnc_${crypto.randomUUID()}`

    const result = await this.client_.createOrder({
      orderId: mspOrderId,
      amountCents,
      currencyCode: input.currency_code,
      description: `Bestelling ${mspOrderId}`,
      notificationUrl,
      redirectUrl,
      cancelUrl,
      idempotencyKey: input.context?.idempotency_key,
      customer: customerCtx
        ? {
            email: customerCtx.email ?? undefined,
            firstName: customerCtx.first_name ?? undefined,
            lastName: customerCtx.last_name ?? undefined,
            address1: billing?.address_1 ?? undefined,
            zipCode: billing?.postal_code ?? undefined,
            city: billing?.city ?? undefined,
            country,
            phone: customerCtx.phone ?? billing?.phone ?? undefined,
          }
        : undefined,
    })

    const data: SessionData = {
      mspOrderId: result.orderId,
      paymentUrl: result.paymentUrl,
      amount: amountCents,
      currency: input.currency_code,
    }

    return {
      id: result.orderId,
      data: data as unknown as Record<string, unknown>,
    }
  }

  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const incoming = (input.data as SessionData | undefined) ?? {}

    // Once the storefront has handed us a transactionId from the redirect,
    // preserve it and don't tear down the MSP order. We only re-initiate
    // when the cart amount changed before any payment was started.
    if (incoming.transactionId) {
      return { data: incoming as Record<string, unknown> }
    }

    const reinitiated = await this.initiatePayment({
      amount: input.amount,
      currency_code: input.currency_code,
      context: input.context,
    } as InitiatePaymentInput)

    return { data: reinitiated.data }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    const data = input.data as SessionData | undefined
    if (data?.mspOrderId && !data.transactionId) {
      await this.client_.cancelOrder(data.mspOrderId).catch((err) => {
        this.logger_.warn(
          `MultiSafepay: failed to cancel order ${data.mspOrderId}: ${(err as Error).message}`
        )
      })
    }
    return { data: input.data }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const data = input.data as SessionData | undefined
    const mspOrderId = data?.mspOrderId
    if (!mspOrderId) {
      // Customer hasn't returned from checkout yet.
      return { data: (data ?? {}) as Record<string, unknown>, status: "pending" }
    }

    const order = await this.client_.getOrder(mspOrderId)

    // Defence in depth: if the storefront wrote a transactionId into the
    // session via the return handler, make sure it matches the one MSP
    // currently knows about. Stops a crafted return URL from settling a
    // cart against some unrelated transaction.
    if (
      data?.transactionId &&
      order.transactionId &&
      String(data.transactionId) !== String(order.transactionId)
    ) {
      this.logger_.warn(
        `MultiSafepay: session transactionId ${data.transactionId} does not match MSP order ${mspOrderId} transaction ${order.transactionId}`
      )
      return { data: (data ?? {}) as Record<string, unknown>, status: "canceled" }
    }

    if (
      typeof data?.amount === "number" &&
      Math.abs(order.amountCents - data.amount) > 1
    ) {
      this.logger_.warn(
        `MultiSafepay: order ${mspOrderId} amount ${order.amountCents} does not match session amount ${data.amount}`
      )
      return { data: (data ?? {}) as Record<string, unknown>, status: "canceled" }
    }

    const nextData: SessionData = {
      ...(data ?? {}),
      mspOrderId,
      transactionId: order.transactionId ?? data?.transactionId,
      status: order.status,
      amount: order.amountCents,
      currency: order.currencyCode,
    }

    return {
      data: nextData as Record<string, unknown>,
      status: this.mapStatus(order.status),
    }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    // MultiSafepay captures funds at payment time for redirect orders. We
    // refresh from MSP to pick up any later state (e.g. uncleared → completed)
    // but never issue a separate capture call.
    const data = input.data as SessionData | undefined
    if (!data?.mspOrderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MultiSafepay: cannot capture without mspOrderId"
      )
    }
    const order = await this.client_.getOrder(data.mspOrderId)
    return {
      data: {
        ...data,
        transactionId: order.transactionId ?? data.transactionId,
        status: order.status,
        amount: order.amountCents,
        currency: order.currencyCode,
      } as Record<string, unknown>,
    }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const data = input.data as SessionData | undefined
    if (data?.mspOrderId && !data.transactionId) {
      await this.client_.cancelOrder(data.mspOrderId).catch(() => undefined)
    }
    return { data: input.data }
  }

  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    // Refunds are explicitly out of scope for the initial MultiSafepay
    // launch; refund operations should be performed in MultiSafepay's
    // dashboard. Surface a clear error so accidental admin calls don't
    // silently succeed.
    void input
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "MultiSafepay refunds are managed in the MultiSafepay dashboard for now"
    )
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = input.data as SessionData | undefined
    if (!data?.mspOrderId) {
      return { data: input.data ?? {} }
    }
    const order = await this.client_.getOrder(data.mspOrderId)
    return {
      data: {
        ...data,
        transactionId: order.transactionId ?? data.transactionId,
        status: order.status,
        amount: order.amountCents,
        currency: order.currencyCode,
      } as Record<string, unknown>,
    }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = input.data as SessionData | undefined
    if (!data?.mspOrderId) {
      return { status: "pending" }
    }
    const order = await this.client_.getOrder(data.mspOrderId)
    return { status: this.mapStatus(order.status) }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const headers = (payload.headers ?? {}) as Record<string, string | string[]>
    const authRaw = headers["auth"] ?? headers["Auth"] ?? headers["AUTH"]
    const authHeader = Array.isArray(authRaw) ? authRaw[0] : authRaw
    const rawBody =
      payload.rawData instanceof Buffer
        ? payload.rawData.toString("utf8")
        : typeof payload.rawData === "string"
          ? payload.rawData
          : ""

    if (!rawBody) {
      this.logger_.warn(
        "MultiSafepay webhook: missing raw body, cannot verify signature"
      )
      return this.notSupported()
    }

    const verification = this.client_.verifyWebhookSignature({
      authHeader,
      rawBody,
    })
    if (verification.ok !== true) {
      this.logger_.warn(
        `MultiSafepay webhook signature rejected: ${verification.reason}`
      )
      return this.notSupported()
    }

    const body = payload.data as MultisafepayWebhookPayload | undefined
    const mspOrderId = body?.order_id
    if (!mspOrderId) {
      return this.notSupported()
    }

    try {
      // Re-fetch from MSP with our server-side API key to pin down the
      // canonical state, even though the HMAC already authenticated the
      // payload. This double-check protects against payload tampering bugs
      // and gives us trustworthy values when the webhook body is ever
      // partially updated by MSP without a corresponding signature change.
      const order = await this.client_.getOrder(mspOrderId)
      const amount = new BigNumber(order.amountCents)
      // Medusa identifies the session via the data we recorded under the
      // session at initiate time; the round-trip identifier here is the
      // mspOrderId, which we also returned as the InitiatePayment id.
      const sessionId = mspOrderId

      if (PAID_STATUSES.includes(order.status)) {
        return { action: "captured", data: { session_id: sessionId, amount } }
      }
      if (AUTHORIZED_STATUSES.includes(order.status)) {
        return { action: "authorized", data: { session_id: sessionId, amount } }
      }
      if (FAILED_STATUSES.includes(order.status)) {
        return { action: "failed", data: { session_id: sessionId, amount } }
      }
      if (REFUNDED_STATUSES.includes(order.status)) {
        // Surface refunds to operators via not_supported + log for now;
        // the refund flow itself is handled in the MSP dashboard for the
        // initial launch.
        this.logger_.info(
          `MultiSafepay refund webhook for ${mspOrderId} (status=${order.status})`
        )
        return this.notSupported()
      }
      return this.notSupported()
    } catch (err) {
      this.logger_.error(
        `MultiSafepay webhook order lookup failed: ${(err as Error).message}`
      )
      return this.notSupported()
    }
  }

  private mapStatus(
    status: MultisafepayStatus
  ): "captured" | "authorized" | "canceled" | "pending" | "error" {
    if (PAID_STATUSES.includes(status)) return "captured"
    if (AUTHORIZED_STATUSES.includes(status)) return "authorized"
    if (FAILED_STATUSES.includes(status)) return "canceled"
    return "pending"
  }

  private notSupported(): WebhookActionResult {
    return {
      action: "not_supported",
      data: { session_id: "", amount: new BigNumber(0) },
    }
  }

  // Medusa hands payment providers `amount` in the major currency unit
  // (e.g. 52 means €52.00). MSP's API expects the value in the smallest
  // unit (cents for EUR, yen for JPY, fils-of-a-thousandth for KWD), so
  // every provider has to perform the conversion itself. The set of
  // zero- and three-decimal currencies follows the official MSP/Stripe
  // currency tables (https://docs.multisafepay.com/docs/currencies,
  // https://docs.stripe.com/currencies).
  private toSmallestUnit(amount: unknown, currencyCode: string): number {
    const decimal = this.amountToNumeric(amount)
    const exponent = decimalsForCurrency(currencyCode)
    const multiplier = Math.pow(10, exponent)
    return Math.round(decimal * multiplier)
  }

  private amountToNumeric(amount: unknown): number {
    if (typeof amount === "number") return amount
    if (typeof amount === "bigint") return Number(amount)
    if (amount && typeof amount === "object" && "numeric" in amount) {
      const n = (amount as { numeric: unknown }).numeric
      if (typeof n === "number") return n
      if (typeof n === "string") return Number(n)
    }
    if (typeof amount === "string") return Number(amount)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `MultiSafepay: cannot interpret amount: ${JSON.stringify(amount)}`
    )
  }
}

export default MultisafepayPaymentProviderService
