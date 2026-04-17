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

import { VivaClient } from "../../../modules/payment-viva-wallet/client"
import type {
  VivaEnvironment,
  VivaTransaction,
  VivaWebhookPayload,
} from "../../../modules/payment-viva-wallet/types"
import { Sentry } from "../../../lib/instrument"
import { EmailTemplates } from "../../../modules/email-notifications/templates"

const PROVIDER_ID = "pp_viva-wallet_viva"
const PAID_STATUSES: Array<VivaTransaction["StatusId"]> = ["F"]
// Viva Event IDs | see modules/payment-viva-wallet/service.ts
const EVENT_TRANSACTION_PAYMENT_CREATED = 1796
const EVENT_TRANSACTION_FAILED = 1798

function getClient(): VivaClient | null {
  const merchantId = process.env.VIVA_MERCHANT_ID
  const apiKey = process.env.VIVA_API_KEY
  const clientId = process.env.VIVA_CLIENT_ID
  const clientSecret = process.env.VIVA_CLIENT_SECRET
  if (!merchantId || !apiKey || !clientId || !clientSecret) return null
  return new VivaClient({
    clientId,
    clientSecret,
    merchantId,
    apiKey,
    environment:
      (process.env.VIVA_ENVIRONMENT as VivaEnvironment | undefined) ??
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
    }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = getClient()
  if (!client) {
    res.status(500).json({
      error: "Viva credentials not configured on the server",
    })
    return
  }

  try {
    const key = await client.getWebhookVerificationKey()
    res.status(200).json({ Key: key })
  } catch (err) {
    const logger = req.scope.resolve("logger") as {
      error: (message: string) => void
    }
    logger.error(
      `Viva webhook verification key fetch failed: ${(err as Error).message}`
    )
    Sentry.captureException(err, {
      tags: { route: 'viva-webhook-verification' },
    })
    res.status(500).json({ error: "failed to fetch verification key" })
  }
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
        data: req.body as Record<string, unknown>,
        rawData: req.rawBody as Buffer,
        headers: req.headers as Record<string, string>,
      },
    })

    await checkAbandonedCartPaid(req, logger).catch((err) => {
      logger.error(
        `Viva webhook abandoned-cart check failed: ${(err as Error).message}`
      )
      Sentry.captureException(err, {
        tags: { route: "viva-webhook-abandoned-cart" },
      })
    })

    await emitPaymentFailed(req, logger).catch((err) => {
      logger.error(
        `Viva webhook payment-failed emit failed: ${(err as Error).message}`
      )
      Sentry.captureException(err, {
        tags: { route: "viva-webhook-payment-failed" },
      })
    })

    res.status(200).json({ received: true })
  } catch (err) {
    logger.error(`Viva webhook handling failed: ${(err as Error).message}`)
    Sentry.captureException(err, {
      tags: { route: 'viva-webhook-post' },
      extra: { headers: req.headers },
    })
    res.status(200).json({ received: false })
  }
}

type SessionDataShape = {
  orderCode?: number
  transactionId?: string
}

async function checkAbandonedCartPaid(
  req: MedusaRequest,
  logger: Logger
): Promise<void> {
  const body = req.body as VivaWebhookPayload | undefined
  if (!body || body.EventTypeId !== EVENT_TRANSACTION_PAYMENT_CREATED) return

  const transactionId = body.EventData?.TransactionId
  if (!transactionId) return

  const client = getClient()
  if (!client) return

  const tx = await client.getTransaction(transactionId)
  if (!PAID_STATUSES.includes(tx.StatusId)) return

  const paymentModule = req.scope.resolve(
    Modules.PAYMENT
  ) as IPaymentModuleService
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  // Find recent Viva payment sessions and match by Viva orderCode.
  // 4h window covers typical checkout attempts plus retries.
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
      String((s.data as SessionDataShape | undefined)?.orderCode ?? "") ===
      String(tx.OrderCode)
  )

  if (!session?.payment_collection_id) {
    logger.warn(
      `abandoned-cart check: no Medusa payment session for Viva orderCode ${tx.OrderCode}`
    )
    Sentry.captureMessage(
      "viva webhook: paid transaction with no matching Medusa payment session",
      {
        level: "warning",
        tags: { route: "viva-webhook-abandoned-cart", kind: "no-session" },
        extra: {
          transactionId,
          orderCode: tx.OrderCode,
          amount: tx.Amount,
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

  const amount = Number(tx.Amount ?? 0)
  const currency = tx.Currency || cart?.currency_code || "EUR"
  const amountFormatted = formatAmount(amount, currency)

  Sentry.captureMessage(
    "viva webhook: paid but no Medusa order (abandoned cart)",
    {
      level: "error",
      tags: { route: "viva-webhook-abandoned-cart", kind: "abandoned-paid" },
      extra: {
        transactionId,
        orderCode: tx.OrderCode,
        amount,
        currency,
        customerEmail: tx.Email ?? cart?.email ?? null,
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
        subject: `[Inovix] Abandoned cart paid | Viva ${tx.OrderCode}`,
      },
      transactionId,
      orderCode: tx.OrderCode,
      amountFormatted,
      currency,
      customerEmail: tx.Email ?? null,
      cartId: cart?.id ?? null,
      cartEmail: cart?.email ?? null,
      paymentMethod: tx.PaymentMethod ?? null,
      detectedAt: new Date().toISOString(),
      preview: "Betaling ontvangen maar geen order in Medusa",
    },
  })

  logger.warn(
    `abandoned-cart-paid alert sent for Viva orderCode ${tx.OrderCode}, cart ${cart?.id ?? "unknown"}`
  )
}

async function emitPaymentFailed(
  req: MedusaRequest,
  logger: Logger
): Promise<void> {
  const body = req.body as VivaWebhookPayload | undefined
  if (!body || body.EventTypeId !== EVENT_TRANSACTION_FAILED) return

  const transactionId = body.EventData?.TransactionId
  if (!transactionId) return

  const client = getClient()
  if (!client) {
    logger.warn(
      "payment.failed: Viva client not configured; skipping event emit"
    )
    return
  }

  const tx = await client.getTransaction(transactionId)

  const eventBus = req.scope.resolve(
    Modules.EVENT_BUS
  ) as IEventBusModuleService

  await eventBus.emit({
    name: "payment.failed",
    data: {
      session_id: tx.MerchantTrns ?? null,
      transaction_id: tx.TransactionId,
      amount: tx.Amount,
      currency_code: tx.Currency,
      customer_email: tx.Email ?? null,
      customer_name: tx.FullName ?? null,
      status_id: tx.StatusId,
    },
  })

  logger.info(
    `payment.failed emitted for Viva tx ${transactionId}, session ${tx.MerchantTrns ?? "unknown"}`
  )
}
