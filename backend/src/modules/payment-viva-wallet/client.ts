import { MedusaError } from "@medusajs/framework/utils"

import type {
  CreateOrderInput,
  CreateOrderResult,
  VivaEnvironment,
  VivaOptions,
  VivaTransaction,
} from "./types"

type Endpoints = {
  accounts: string
  api: string
  checkout: string
  www: string
}

const ENDPOINTS: Record<VivaEnvironment, Endpoints> = {
  production: {
    accounts: "https://accounts.vivapayments.com",
    api: "https://api.vivapayments.com",
    checkout: "https://www.vivapayments.com/web/checkout",
    www: "https://www.vivapayments.com",
  },
  demo: {
    accounts: "https://demo-accounts.vivapayments.com",
    api: "https://demo-api.vivapayments.com",
    checkout: "https://demo.vivapayments.com/web/checkout",
    www: "https://demo.vivapayments.com",
  },
}

type TokenCache = {
  accessToken: string
  expiresAt: number
}

export class VivaClient {
  private readonly options: VivaOptions
  private readonly endpoints: Endpoints
  private tokenCache: TokenCache | null = null

  constructor(options: VivaOptions) {
    this.options = options
    this.endpoints = ENDPOINTS[options.environment ?? "production"]
  }

  async getCheckoutUrl(orderCode: number): Promise<string> {
    return `${this.endpoints.checkout}?ref=${orderCode}`
  }

  async getWebhookVerificationKey(): Promise<string> {
    const res = await this.basicAuthFetch(
      `${this.endpoints.www}/api/messages/config/token`,
      { method: "GET" }
    )
    const data = (await res.json()) as { Key?: string }
    if (!data.Key) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Viva: token endpoint returned no Key"
      )
    }
    return data.Key
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const body: Record<string, unknown> = {
      amount: input.amountCents,
      currencyCode: this.currencyCodeToIso4217(input.currencyCode),
      customerTrns: input.customerTrns,
      merchantTrns: input.merchantTrns,
      sourceCode: this.options.sourceCode,
      allowRecurring: false,
      paymentTimeout: 900,
    }

    if (input.customer) {
      body.customer = {
        email: input.customer.email,
        fullName: input.customer.fullName,
        phone: input.customer.phone,
        countryCode: input.customer.countryCode,
        requestLang: input.customer.requestLang ?? "nl-NL",
      }
    }

    const res = await this.oauthFetch(
      `${this.endpoints.api}/checkout/v2/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        idempotencyKey: input.idempotencyKey,
      }
    )

    const data = (await res.json()) as { orderCode?: number }
    if (!data.orderCode) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Viva createOrder: missing orderCode in response"
      )
    }

    return {
      orderCode: data.orderCode,
      checkoutUrl: await this.getCheckoutUrl(data.orderCode),
    }
  }

  async getTransaction(transactionId: string): Promise<VivaTransaction> {
    const res = await this.basicAuthFetch(
      `${this.endpoints.api}/checkout/v2/transactions/${encodeURIComponent(transactionId)}`,
      { method: "GET" }
    )
    const data = (await res.json()) as { Transactions?: VivaTransaction[] }
    const tx = data.Transactions?.[0]
    if (!tx) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Viva transaction ${transactionId} not found`
      )
    }
    return tx
  }

  async cancelOrder(orderCode: number): Promise<void> {
    await this.oauthFetch(
      `${this.endpoints.api}/checkout/v2/orders/${orderCode}`,
      { method: "DELETE" }
    )
  }

  async refundTransaction(
    transactionId: string,
    amountCents: number,
    idempotencyKey?: string
  ): Promise<{ TransactionId: string }> {
    const url = `${this.endpoints.api}/api/transactions/${encodeURIComponent(transactionId)}?amount=${amountCents}&actionUser=Medusa`
    const res = await this.basicAuthFetch(url, {
      method: "DELETE",
      idempotencyKey,
    })
    return (await res.json()) as { TransactionId: string }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && this.tokenCache.expiresAt - 30_000 > now) {
      return this.tokenCache.accessToken
    }

    const credentials = Buffer.from(
      `${this.options.clientId}:${this.options.clientSecret}`
    ).toString("base64")

    const res = await fetch(`${this.endpoints.accounts}/connect/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: "grant_type=client_credentials",
    })

    if (!res.ok) {
      const text = await res.text()
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        `Viva OAuth failed: ${res.status} ${text}`
      )
    }

    const data = (await res.json()) as {
      access_token: string
      expires_in: number
    }

    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    }

    return data.access_token
  }

  private async oauthFetch(
    url: string,
    init: RequestInit & { idempotencyKey?: string }
  ): Promise<Response> {
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${token}`)
    if (init.idempotencyKey) {
      headers.set("Idempotency-Key", init.idempotencyKey)
    }

    const res = await fetch(url, { ...init, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Viva API ${init.method ?? "GET"} ${url} failed: ${res.status} ${text}`
      )
    }
    return res
  }

  private async basicAuthFetch(
    url: string,
    init: RequestInit & { idempotencyKey?: string }
  ): Promise<Response> {
    const credentials = Buffer.from(
      `${this.options.merchantId}:${this.options.apiKey}`
    ).toString("base64")
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Basic ${credentials}`)
    if (init.idempotencyKey) {
      headers.set("Idempotency-Key", init.idempotencyKey)
    }

    const res = await fetch(url, { ...init, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Viva API ${init.method ?? "GET"} ${url} failed: ${res.status} ${text}`
      )
    }
    return res
  }

  private currencyCodeToIso4217(code: string): number {
    const map: Record<string, number> = {
      EUR: 978,
      USD: 840,
      GBP: 826,
      CHF: 756,
      DKK: 208,
      SEK: 752,
      NOK: 578,
      PLN: 985,
      RON: 946,
      HUF: 348,
      CZK: 203,
      BGN: 975,
      HRK: 191,
    }
    const numeric = map[code.toUpperCase()]
    if (!numeric) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Viva: unsupported currency ${code}`
      )
    }
    return numeric
  }
}
