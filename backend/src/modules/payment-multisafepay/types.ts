export type MultisafepayEnvironment = "production" | "test"

export type MultisafepayOptions = {
  apiKey: string
  environment?: MultisafepayEnvironment
  // Tolerance in seconds for webhook timestamp drift. Defaults to 300 (5 minutes).
  // Notifications older than this are rejected to limit replay window.
  webhookTimestampToleranceSeconds?: number
}

export type MultisafepayCustomer = {
  email?: string
  firstName?: string
  lastName?: string
  address1?: string
  houseNumber?: string
  zipCode?: string
  city?: string
  country?: string
  phone?: string
  locale?: string
}

export type CreateOrderInput = {
  orderId: string
  amountCents: number
  currencyCode: string
  description?: string
  notificationUrl?: string
  redirectUrl?: string
  cancelUrl?: string
  customer?: MultisafepayCustomer
  idempotencyKey?: string
}

export type CreateOrderResult = {
  orderId: string
  paymentUrl: string
}

// MultiSafepay order status values from
// https://docs.multisafepay.com/docs/transaction-statuses
export type MultisafepayStatus =
  | "initialized"
  | "completed"
  | "uncleared"
  | "void"
  | "declined"
  | "expired"
  | "cancelled"
  | "chargedback"
  | "refunded"
  | "partial_refunded"
  | "shipped"
  | "reserved"

export type MultisafepayOrder = {
  orderId: string
  status: MultisafepayStatus
  amountCents: number
  currencyCode: string
  transactionId?: string | null
  paymentUrl?: string | null
  customerEmail?: string | null
  customerFullName?: string | null
  paymentMethod?: string | null
}

// Shape of the JSON body MultiSafepay POSTs to our notification_url.
// The full structure is documented at
// https://docs.multisafepay.com/docs/webhook | we type only what we use.
export type MultisafepayWebhookPayload = {
  order_id?: string
  transaction_id?: string | number
  status?: MultisafepayStatus
  amount?: number
  currency?: string
  payment_details?: {
    type?: string
    [key: string]: unknown
  }
  customer?: {
    email?: string
    first_name?: string
    last_name?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}
