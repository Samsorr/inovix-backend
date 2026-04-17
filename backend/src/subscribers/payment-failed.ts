import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { INotificationModuleService, Logger } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'

type PaymentFailedData = {
  session_id?: string | null
  transaction_id?: string | null
  amount?: number | null
  currency_code?: string | null
  customer_email?: string | null
  customer_name?: string | null
}

const CURRENCY_LOCALE: Record<string, string> = {
  eur: 'nl-NL',
  usd: 'en-US',
  gbp: 'en-GB',
}

function formatAmount(amount: number | null | undefined, currency: string): string {
  const numeric = Number(amount ?? 0)
  const locale = CURRENCY_LOCALE[currency.toLowerCase()] ?? 'nl-NL'
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)
  } catch {
    return numeric.toFixed(2)
  }
}

function storefrontRetryUrl(cartId?: string | null): string {
  const base = (process.env.STOREFRONT_URL ?? 'https://inovix-peptides.com').replace(/\/$/, '')
  return cartId ? `${base}/winkelwagen?cart_id=${encodeURIComponent(cartId)}` : `${base}/winkelwagen`
}

export default async function paymentFailedHandler({
  event: { data },
  container,
}: SubscriberArgs<PaymentFailedData>) {
  const notificationModuleService: INotificationModuleService = container.resolve(Modules.NOTIFICATION)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger: Logger = container.resolve('logger')

  const sessionId = data.session_id ?? null
  const transactionId = data.transaction_id ?? null
  const currency = (data.currency_code ?? 'eur').toLowerCase()

  let recipientEmail = data.customer_email ?? null
  let customerName = data.customer_name ?? null
  let cartId: string | null = null

  try {
    // Fall back to the cart linked to the payment session when the webhook
    // payload didn't include a customer email.
    if (sessionId) {
      const { data: carts } = await query.graph({
        entity: 'cart',
        filters: { 'payment_collection.payment_sessions.id': sessionId },
        fields: [
          'id',
          'email',
          'shipping_address.first_name',
          'shipping_address.last_name',
        ],
      })
      const cart = carts?.[0]
      if (cart) {
        cartId = cart.id ?? null
        if (!recipientEmail) recipientEmail = cart.email ?? null
        if (!customerName && cart.shipping_address) {
          const first = cart.shipping_address.first_name ?? ''
          const last = cart.shipping_address.last_name ?? ''
          const full = `${first} ${last}`.trim()
          customerName = full || null
        }
      }
    }

    if (!recipientEmail) {
      logger.warn(
        `payment.failed: no recipient email resolved for session ${sessionId ?? 'unknown'}; skipping notification`
      )
      return
    }

    const amountFormatted = formatAmount(data.amount ?? 0, currency)
    const retryUrl = storefrontRetryUrl(cartId)
    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const idempotencyBase = transactionId || sessionId || `${recipientEmail}-${Date.now()}`

    const textBody =
      `Betaling mislukt\n\n` +
      `Beste ${customerName || 'daar'},\n\n` +
      `Uw betaling van ${amountFormatted} ${currency.toUpperCase()} kon niet worden verwerkt. ` +
      `Dit kan onvoldoende saldo, een geblokkeerde kaart of afgebroken 3D Secure zijn.\n\n` +
      `Uw winkelwagen staat nog voor u klaar. Probeer opnieuw via:\n${retryUrl}\n\n` +
      `Lukt het niet? Reageer op deze e-mail dan zoeken wij het voor u uit.`

    await notificationModuleService.createNotifications({
      to: recipientEmail,
      channel: 'email',
      template: EmailTemplates.PAYMENT_FAILED,
      idempotency_key: `payment-failed-${idempotencyBase}`,
      resource_id: cartId ?? sessionId ?? undefined,
      resource_type: cartId ? 'cart' : 'payment_session',
      trigger_type: 'payment.failed',
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: `Betaling mislukt | Inovix`,
          text: textBody,
        },
        customerName,
        amountFormatted,
        currency,
        retryUrl,
        preview: 'Uw betaling is niet gelukt, probeer opnieuw',
      },
    })
  } catch (error) {
    logger.error(
      `payment.failed: failed to send notification for session ${sessionId ?? 'unknown'}: ${(error as Error).message}`
    )
    Sentry.captureException(error, {
      tags: { subscriber: 'payment.failed' },
      extra: { sessionId, transactionId },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'payment.failed',
}
