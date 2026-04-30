import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"
import type {
  IEventBusModuleService,
  INotificationModuleService,
  IPaymentModuleService,
  Logger,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { MultisafepayClient } from "../../../modules/payment-multisafepay/client"
import type {
  MultisafepayEnvironment,
  MultisafepayOrder,
  MultisafepayWebhookPayload,
} from "../../../modules/payment-multisafepay/types"
import { Sentry } from "../../../lib/instrument"
import { EmailTemplates } from "../../../modules/email-notifications/templates"

const PROVIDER_ID = "pp_multisafepay_multisafepay"
const PAID_STATUSES = ["completed"] as const
const FAILED_STATUSES = [
  "declined",
  "expired",
  "cancelled",
  "void",
] as const

function getClient(): MultisafepayClient | null {
  const apiKey = process.env.MULTISAFEPAY_API_KEY
  if (!apiKey) return null
  return new MultisafepayClient({
    apiKey,
    environment:
      (process.env.MULTISAFEPAY_ENVIRONMENT as MultisafepayEnvironment | undefined) ??
      "production",
  })
}

function formatAmount(amount: number, currency: string): string {
  const locale = currency?.toLowerCase() === "eur" ? "nl-NL" : "en-US"
  try {
    return new Intl.NumberFormat(locale, {
      style: "decimal",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount / 100)
  } catch {
    return (amount / 100).toFixed(2)
  }
}

// MSP retries 3x at 15-min intervals on a non-200 response, with the same
// signed timestamp. Always reply 200 + plain text "OK" to acknowledge per
// https://docs.multisafepay.com/docs/webhook so MSP doesn't keep retrying.
function ackOk(res: MedusaResponse): void {
  res.status(200).type("text/plain").send("OK")
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const paymentModule = req.scope.resolve(Modules.PAYMENT)
  const logger = req.scope.resolve("logger") as Logger

  try {
    await paymentModule.getWebhookActionAndData({
      provider: PROVIDER_ID,
      payload: {
        data: (req.body ?? {}) as Record<string, unknown>,
        rawData: req.rawBody as Buffer,
        headers: req.headers as Record<string, string>,
      },
    })

    await checkAbandonedCartPaid(req, logger).catch((err) => {
      logger.error(
        `MultiSafepay webhook abandoned-cart check failed: ${(err as Error).message}`
      )
      Sentry.captureException(err, {
        tags: { route: "multisafepay-webhook-abandoned-cart" },
      })
    })

    await emitPaymentFailed(req, logger).catch((err) => {
      logger.error(
        `MultiSafepay webhook payment-failed emit failed: ${(err as Error).message}`
      )
      Sentry.captureException(err, {
        tags: { route: "multisafepay-webhook-payment-failed" },
      })
    })

    ackOk(res)
  } catch (err) {
    logger.error(
      `MultiSafepay webhook handling failed: ${(err as Error).message}`
    )
    Sentry.captureException(err, {
      tags: { route: "multisafepay-webhook-post" },
    })
    // Still ack | retries don't fix application bugs and just amplify them.
    ackOk(res)
  }
}

// MSP also supports GET notifications (?transactionid=...&timestamp=...).
// We don't subscribe to GET, but accept and ack one to be defensive in case
// a manual "Resend webhook" from the MSP dashboard fires GET.
export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  ackOk(res)
}

type SessionDataShape = {
  mspOrderId?: string
  transactionId?: string
}

async function fetchOrderFromWebhook(
  body: MultisafepayWebhookPayload | undefined
): Promise<MultisafepayOrder | null> {
  if (!body?.order_id) return null
  const client = getClient()
  if (!client) return null
  return client.getOrder(body.order_id)
}

async function checkAbandonedCartPaid(
  req: MedusaRequest,
  logger: Logger
): Promise<void> {
  const body = req.body as MultisafepayWebhookPayload | undefined
  const order = await fetchOrderFromWebhook(body)
  if (!order) return
  if (!PAID_STATUSES.includes(order.status as (typeof PAID_STATUSES)[number])) return

  const paymentModule = req.scope.resolve(Modules.PAYMENT) as IPaymentModuleService
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
  const sessions = await paymentModule.listPaymentSessions(
    {
      provider_id: PROVIDER_ID,
      created_at: { $gte: cutoff },
    },
    { take: 500 }
  )

  const session = sessions.find(
    (s) =>
      String((s.data as SessionDataShape | undefined)?.mspOrderId ?? "") ===
      String(order.orderId)
  )

  if (!session?.payment_collection_id) {
    logger.warn(
      `abandoned-cart check: no Medusa payment session for MSP order ${order.orderId}`
    )
    Sentry.captureMessage(
      "multisafepay webhook: paid order with no matching Medusa payment session",
      {
        level: "warning",
        tags: { route: "multisafepay-webhook-abandoned-cart", kind: "no-session" },
        extra: {
          orderId: order.orderId,
          transactionId: order.transactionId,
          amount: order.amountCents,
        },
      }
    )
    return
  }

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: ["id", "email", "completed_at", "currency_code"],
    filters: { payment_collection_id: session.payment_collection_id },
  })

  const cart = carts?.[0] as
    | {
        id: string
        email?: string | null
        completed_at?: string | null
        currency_code?: string | null
      }
    | undefined

  if (cart?.completed_at) return

  const amount = order.amountCents
  const currency = order.currencyCode || cart?.currency_code || "EUR"
  const amountFormatted = formatAmount(amount, currency)

  Sentry.captureMessage(
    "multisafepay webhook: paid but no Medusa order (abandoned cart)",
    {
      level: "error",
      tags: { route: "multisafepay-webhook-abandoned-cart", kind: "abandoned-paid" },
      extra: {
        orderId: order.orderId,
        transactionId: order.transactionId,
        amount,
        currency,
        customerEmail: order.customerEmail ?? cart?.email ?? null,
        cartId: cart?.id ?? null,
        paymentSessionId: session.id,
        paymentCollectionId: session.payment_collection_id,
      },
    }
  )

  const adminEmail = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
  if (!adminEmail) {
    logger.warn(
      "abandoned-cart-paid detected but SUPPORT_EMAIL/CONTACT_EMAIL not set; skipping admin email"
    )
    return
  }

  const notificationModule = req.scope.resolve(
    Modules.NOTIFICATION
  ) as INotificationModuleService

  await notificationModule.createNotifications({
    to: adminEmail,
    channel: "email",
    template: EmailTemplates.ABANDONED_CART_PAID,
    data: {
      emailOptions: {
        subject: `[Inovix] Abandoned cart paid | MSP ${order.orderId}`,
      },
      transactionId: order.transactionId ?? "",
      orderCode: order.orderId,
      amountFormatted,
      currency,
      customerEmail: order.customerEmail ?? null,
      cartId: cart?.id ?? null,
      cartEmail: cart?.email ?? null,
      paymentMethod: order.paymentMethod ?? null,
      detectedAt: new Date().toISOString(),
      preview: "Betaling ontvangen maar geen order in Medusa",
    },
  })

  logger.warn(
    `abandoned-cart-paid alert sent for MSP order ${order.orderId}, cart ${cart?.id ?? "unknown"}`
  )
}

async function emitPaymentFailed(
  req: MedusaRequest,
  logger: Logger
): Promise<void> {
  const body = req.body as MultisafepayWebhookPayload | undefined
  const order = await fetchOrderFromWebhook(body)
  if (!order) return
  if (!FAILED_STATUSES.includes(order.status as (typeof FAILED_STATUSES)[number])) return

  const eventBus = req.scope.resolve(Modules.EVENT_BUS) as IEventBusModuleService

  await eventBus.emit({
    name: "payment.failed",
    data: {
      session_id: order.orderId,
      transaction_id: order.transactionId ?? null,
      amount: order.amountCents,
      currency_code: order.currencyCode,
      customer_email: order.customerEmail ?? null,
      customer_name: order.customerFullName ?? null,
      status_id: order.status,
    },
  })

  logger.info(
    `payment.failed emitted for MSP order ${order.orderId}, status ${order.status}`
  )
}
