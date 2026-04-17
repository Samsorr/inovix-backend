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

import { VivaClient } from "./client"
import type { VivaOptions, VivaTransaction, VivaWebhookPayload } from "./types"

type InjectedDependencies = {
  logger: Logger
}

type SessionData = {
  orderCode?: number
  transactionId?: string
  checkoutUrl?: string
  status?: VivaTransaction["StatusId"]
  amount?: number
  currency?: string
}

const PAID_STATUSES: Array<VivaTransaction["StatusId"]> = ["F"]
const AUTHORIZED_STATUSES: Array<VivaTransaction["StatusId"]> = ["A"]
const FAILED_STATUSES: Array<VivaTransaction["StatusId"]> = ["E", "X", "C"]

class VivaPaymentProviderService extends AbstractPaymentProvider<VivaOptions> {
  static identifier = "viva-wallet"

  protected readonly logger_: Logger
  protected readonly options_: VivaOptions
  protected readonly client_: VivaClient

  constructor(container: InjectedDependencies, options: VivaOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new VivaClient(options)
  }

  static validateOptions(options: Record<string, unknown>) {
    const required = ["clientId", "clientSecret", "merchantId", "apiKey"] as const
    for (const key of required) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Viva Wallet: missing required option '${key}'`
        )
      }
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const amountCents = this.toCents(input.amount)
    const customer = input.context?.customer

    const result = await this.client_.createOrder({
      amountCents,
      currencyCode: input.currency_code,
      customer: customer
        ? {
            email: customer.email ?? undefined,
            fullName: [customer.first_name, customer.last_name]
              .filter(Boolean)
              .join(" ") || undefined,
            phone: customer.phone ?? undefined,
          }
        : undefined,
      idempotencyKey: input.context?.idempotency_key,
    })

    const data: SessionData = {
      orderCode: result.orderCode,
      checkoutUrl: result.checkoutUrl,
      amount: amountCents,
      currency: input.currency_code,
    }

    return {
      id: String(result.orderCode),
      data: data as unknown as Record<string, unknown>,
    }
  }

  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const incoming = (input.data as SessionData | undefined) ?? {}

    // The storefront's Viva return handler calls updatePaymentSession with the
    // transactionId from Viva's redirect. Preserve it instead of creating a new
    // Viva order — we only re-initiate for amount changes.
    if (incoming.transactionId) {
      return { data: incoming as Record<string, unknown> }
    }

    const reinitiated = await this.initiatePayment({
      amount: input.amount,
      currency_code: input.currency_code,
      context: input.context,
    } as InitiatePaymentInput)

    return {
      data: reinitiated.data,
    }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    const data = input.data as SessionData | undefined
    if (data?.orderCode && !data.transactionId) {
      await this.client_.cancelOrder(data.orderCode).catch((err) => {
        this.logger_.warn(
          `Viva: failed to cancel order ${data.orderCode}: ${err.message}`
        )
      })
    }
    return { data: input.data }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const data = input.data as SessionData | undefined
    const transactionId = data?.transactionId
    if (!transactionId) {
      // Customer hasn't returned from checkout yet.
      return { data: (data ?? {}) as Record<string, unknown>, status: "pending" }
    }

    const tx = await this.client_.getTransaction(transactionId)
    const nextData: SessionData = {
      ...(data ?? {}),
      transactionId,
      status: tx.StatusId,
      amount: tx.Amount,
      currency: tx.Currency,
    }

    if (PAID_STATUSES.includes(tx.StatusId)) {
      return { data: nextData as Record<string, unknown>, status: "captured" }
    }
    if (AUTHORIZED_STATUSES.includes(tx.StatusId)) {
      return { data: nextData as Record<string, unknown>, status: "authorized" }
    }
    if (FAILED_STATUSES.includes(tx.StatusId)) {
      return { data: nextData as Record<string, unknown>, status: "canceled" }
    }
    return { data: nextData as Record<string, unknown>, status: "pending" }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    // Smart Checkout captures at payment time; we only refresh the transaction.
    const data = input.data as SessionData | undefined
    if (!data?.transactionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Viva: cannot capture without transactionId"
      )
    }
    const tx = await this.client_.getTransaction(data.transactionId)
    return {
      data: {
        ...data,
        status: tx.StatusId,
        amount: tx.Amount,
        currency: tx.Currency,
      } as Record<string, unknown>,
    }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const data = input.data as SessionData | undefined
    if (data?.orderCode && !data.transactionId) {
      await this.client_.cancelOrder(data.orderCode).catch(() => undefined)
    }
    return { data: input.data }
  }

  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const data = input.data as SessionData | undefined
    if (!data?.transactionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Viva: cannot refund without transactionId"
      )
    }
    const amountCents = this.toCents(input.amount)
    await this.client_.refundTransaction(data.transactionId, amountCents)
    return { data: input.data }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = input.data as SessionData | undefined
    if (!data?.transactionId) {
      return { data: input.data ?? {} }
    }
    const tx = await this.client_.getTransaction(data.transactionId)
    return {
      data: {
        ...data,
        status: tx.StatusId,
        amount: tx.Amount,
        currency: tx.Currency,
      } as Record<string, unknown>,
    }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = input.data as SessionData | undefined
    if (!data?.transactionId) {
      return { status: "pending" }
    }
    const tx = await this.client_.getTransaction(data.transactionId)
    if (PAID_STATUSES.includes(tx.StatusId)) return { status: "captured" }
    if (AUTHORIZED_STATUSES.includes(tx.StatusId)) return { status: "authorized" }
    if (FAILED_STATUSES.includes(tx.StatusId)) return { status: "canceled" }
    return { status: "pending" }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const body = payload.data as unknown as VivaWebhookPayload
    const event = body?.EventTypeId
    const eventData = body?.EventData ?? {}
    const transactionId =
      (eventData as { TransactionId?: string }).TransactionId

    if (!transactionId) {
      return this.notSupported()
    }

    try {
      // Re-fetch from Viva to validate authenticity and get canonical values.
      const tx = await this.client_.getTransaction(transactionId)
      const sessionId = tx.MerchantTrns ?? undefined
      const amount = new BigNumber(tx.Amount ?? 0)

      switch (event) {
        case 1796: {
          // Transaction Payment Created
          if (PAID_STATUSES.includes(tx.StatusId)) {
            return {
              action: "captured",
              data: { session_id: sessionId ?? "", amount },
            }
          }
          if (AUTHORIZED_STATUSES.includes(tx.StatusId)) {
            return {
              action: "authorized",
              data: { session_id: sessionId ?? "", amount },
            }
          }
          return this.notSupported()
        }
        case 1798: // Transaction Failed
          return {
            action: "failed",
            data: { session_id: sessionId ?? "", amount },
          }
        case 1797: // Transaction Reversal Created (refund)
          return this.notSupported()
        default:
          return this.notSupported()
      }
    } catch (err) {
      this.logger_.error(
        `Viva webhook verification failed: ${(err as Error).message}`
      )
      return this.notSupported()
    }
  }

  private notSupported(): WebhookActionResult {
    return {
      action: "not_supported",
      data: { session_id: "", amount: new BigNumber(0) },
    }
  }

  private toCents(amount: unknown): number {
    if (typeof amount === "number") {
      return Math.round(amount)
    }
    if (amount && typeof amount === "object" && "numeric" in amount) {
      const n = (amount as { numeric: unknown }).numeric
      if (typeof n === "number") return Math.round(n)
      if (typeof n === "string") return Math.round(Number(n))
    }
    if (typeof amount === "string") {
      return Math.round(Number(amount))
    }
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Viva: cannot convert amount to cents: ${JSON.stringify(amount)}`
    )
  }
}

export default VivaPaymentProviderService
