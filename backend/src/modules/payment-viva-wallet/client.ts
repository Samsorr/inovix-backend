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

  async getCheckoutUrl(orderCode: string): Promise<string> {
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

    if (input.webhookUrl) {
      body.webhookUrl = input.webhookUrl
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

    // Parse body as raw text first: Viva orderCodes are 16-digit numbers
    // that exceed JS MAX_SAFE_INTEGER, so we must never let JSON.parse
    // coerce them to a number.
    const rawText = await res.text()
    const match = rawText.match(/"orderCode"\s*:\s*(\d+)/)
    const orderCode = match?.[1]
    if (!orderCode) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Viva createOrder: missing orderCode in response"
      )
    }

    return {
      orderCode,
      checkoutUrl: await this.getCheckoutUrl(orderCode),
    }
  }

  async getTransaction(transactionId: string): Promise<VivaTransaction> {
    // Use OAuth (Smart Checkout credentials) rather than basic auth. Both
    // are accepted by Viva's checkout v2 endpoint, and OAuth works reliably
    // in demo and prod without depending on the shorter basic-auth API key.
    const res = await this.oauthFetch(
      `${this.endpoints.api}/checkout/v2/transactions/${encodeURIComponent(transactionId)}`,
      { method: "GET" }
    )
    const raw = (await res.json()) as Record<string, unknown>

    // Two response shapes exist: the legacy basic-auth shape wraps matches
    // in `{Transactions: [{StatusId, Amount, Currency, ...}]}`; the OAuth
    // shape returns a single object with lowercase keys (`statusId`,
    // `amount`, `currencyCode`). Normalise both to VivaTransaction.
    const legacy = raw as { Transactions?: Array<Partial<VivaTransaction> & { OrderCode?: string | number }> }
    const legacyTx = legacy.Transactions?.[0]
    if (legacyTx && typeof legacyTx.StatusId === "string") {
      return {
        ...legacyTx,
        StatusId: legacyTx.StatusId,
        Amount: Number(legacyTx.Amount ?? 0),
        Currency: String(legacyTx.Currency ?? ""),
        OrderCode: String(legacyTx.OrderCode ?? ""),
        TransactionId: String(legacyTx.TransactionId ?? transactionId),
      } as VivaTransaction
    }

    if (typeof raw.statusId === "string") {
      const tx = raw as {
        statusId: VivaTransaction["StatusId"]
        amount: number
        currencyCode: number | string
        orderCode: string | number
        transactionId?: string
        merchantTrns?: string | null
        customerTrns?: string | null
        email?: string | null
        fullName?: string | null
      }
      return {
        StatusId: tx.statusId,
        // OAuth shape returns amount in major units (e.g. 5.10 EUR); the
        // legacy basic-auth shape returns cents. Normalise to cents so our
        // service's reconciliation logic stays consistent.
        Amount: Math.round(Number(tx.amount) * 100),
        Currency: this.currencyNumericToIso(tx.currencyCode),
        OrderCode: String(tx.orderCode),
        TransactionId: tx.transactionId ?? transactionId,
        MerchantTrns: tx.merchantTrns ?? null,
        CustomerTrns: tx.customerTrns ?? null,
        Email: tx.email ?? null,
        FullName: tx.fullName ?? null,
      }
    }

    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Viva transaction ${transactionId} not found`
    )
  }

  async cancelOrder(orderCode: string): Promise<void> {
    try {
      await this.oauthFetch(
        `${this.endpoints.api}/checkout/v2/orders/${orderCode}`,
        { method: "DELETE" }
      )
    } catch (err) {
      // Viva returns 404 when the order has already expired or been
      // consumed — that's a benign state for our cleanup path. Any other
      // error still propagates so real failures stay visible.
      const msg = (err as Error).message ?? ""
      if (!msg.includes("404")) throw err
    }
  }

  async refundTransaction(
    transactionId: string,
    amountCents: number,
    idempotencyKey?: string
  ): Promise<{ TransactionId: string }> {
    const params = new URLSearchParams({
      amount: String(amountCents),
      actionUser: "Medusa",
    })
    const url = `${this.endpoints.api}/api/transactions/${encodeURIComponent(transactionId)}?${params}`
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
    const doFetch = async () => {
      const token = await this.getAccessToken()
      const headers = new Headers(init.headers)
      headers.set("Authorization", `Bearer ${token}`)
      if (init.idempotencyKey) {
        headers.set("Idempotency-Key", init.idempotencyKey)
      }
      return fetch(url, { ...init, headers })
    }

    let res = await doFetch()

    // Viva can revoke tokens before their advertised expiry. On a 401
    // clear the cache and retry exactly once with a fresh token.
    if (res.status === 401) {
      this.tokenCache = null
      res = await doFetch()
    }

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
    const numeric = CURRENCY_ISO_NUMERIC[code.toUpperCase()]
    if (!numeric) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Viva: unsupported currency ${code}`
      )
    }
    return numeric
  }

  private currencyNumericToIso(code: number | string): string {
    const numeric = typeof code === "number" ? code : Number(code)
    const alpha = Object.entries(CURRENCY_ISO_NUMERIC).find(
      ([, n]) => n === numeric
    )?.[0]
    return alpha ?? String(code)
  }
}

const CURRENCY_ISO_NUMERIC: Record<string, number> = {
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
