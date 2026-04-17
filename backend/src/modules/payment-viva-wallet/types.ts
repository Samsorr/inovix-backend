export type VivaEnvironment = "production" | "demo"

export type VivaOptions = {
  clientId: string
  clientSecret: string
  merchantId: string
  apiKey: string
  sourceCode?: string
  environment?: VivaEnvironment
  successUrl?: string
  failureUrl?: string
}

export type VivaCustomer = {
  email?: string
  fullName?: string
  phone?: string
  countryCode?: string
  requestLang?: string
}

export type CreateOrderInput = {
  amountCents: number
  currencyCode: string
  merchantTrns?: string
  customerTrns?: string
  customer?: VivaCustomer
  idempotencyKey?: string
}

export type CreateOrderResult = {
  orderCode: number
  checkoutUrl: string
}

export type VivaTransactionStatus =
  | "F"
  | "A"
  | "E"
  | "X"
  | "R"
  | "M"
  | "P"
  | "C"

export type VivaTransaction = {
  StatusId: VivaTransactionStatus
  Amount: number
  Currency: string
  OrderCode: number
  TransactionId: string
  MerchantTrns?: string | null
  CustomerTrns?: string | null
  Email?: string | null
  FullName?: string | null
  Phone?: string | null
  PaymentMethod?: string | null
  CardNumber?: string | null
}

export type VivaWebhookPayload = {
  EventTypeId: number
  Created: string
  Url?: string
  EventData: Record<string, unknown> & {
    TransactionId?: string
    OrderCode?: number
    Amount?: number
    StatusId?: VivaTransactionStatus
    MerchantTrns?: string
    Email?: string
  }
}
