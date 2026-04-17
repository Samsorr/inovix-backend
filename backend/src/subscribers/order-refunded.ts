import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  INotificationModuleService,
  IPaymentModuleService,
  Logger,
} from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'

type RefundEventData = {
  id: string
}

export default async function orderRefundedHandler({
  event: { data },
  container,
}: SubscriberArgs<RefundEventData>) {
  const notificationModuleService: INotificationModuleService =
    container.resolve(Modules.NOTIFICATION)
  const paymentModuleService: IPaymentModuleService = container.resolve(
    Modules.PAYMENT
  )
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger: Logger = container.resolve('logger')

  const paymentId = data.id

  try {
    const payment = await paymentModuleService.retrievePayment(paymentId, {
      relations: ['refunds', 'payment_collection'],
    })

    const refunds = (payment.refunds ?? []).slice().sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return bTime - aTime
    })
    const latestRefund = refunds[0]

    if (!latestRefund) {
      logger.warn(
        `payment.refunded: payment ${paymentId} has no refunds; skipping notification`
      )
      return
    }

    const refundAmount = Number(latestRefund.amount ?? 0)
    const refundedAt = latestRefund.created_at ?? null
    const reason = latestRefund.note ?? null

    const { data: orders } = await query.graph({
      entity: 'order',
      filters: { 'payment_collections.payments.id': paymentId },
      fields: [
        'id',
        'display_id',
        'email',
        'currency_code',
        'shipping_address.*',
      ],
    })

    const order = orders?.[0]

    if (!order) {
      logger.warn(
        `payment.refunded: no order found for payment ${paymentId}; skipping notification`
      )
      return
    }

    if (!order.email) {
      logger.warn(
        `payment.refunded: order ${order.id} has no email; skipping notification`
      )
      return
    }

    if (!order.shipping_address) {
      logger.warn(
        `payment.refunded: order ${order.id} has no shipping_address; skipping notification`
      )
      return
    }

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const currency = (order.currency_code ?? 'EUR').toUpperCase()
    const refundText = `${refundAmount.toFixed(2)} ${currency}`

    const textBody =
      `Uw terugstorting is verwerkt\n` +
      `Ordernummer #${order.display_id}\n\n` +
      `Beste ${order.shipping_address.first_name} ${order.shipping_address.last_name},\n\n` +
      `We bevestigen dat de terugstorting voor uw bestelling is verwerkt. ` +
      `Het bedrag staat over enkele werkdagen op uw rekening, afhankelijk van ` +
      `uw bank of kaartuitgever.\n\n` +
      `Teruggestort bedrag: ${refundText}\n` +
      (reason ? `Reden: ${reason}\n` : '') +
      `\n` +
      `De terugstorting wordt naar dezelfde betaalmethode gestuurd waarmee u ` +
      `oorspronkelijk heeft betaald. De verwerkingstijd is doorgaans 5 tot 10 ` +
      `werkdagen. Heeft u na 10 werkdagen nog niets ontvangen, neem dan contact ` +
      `met ons op.`

    await notificationModuleService.createNotifications({
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_REFUNDED,
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: `Terugstorting verwerkt | Inovix ${order.display_id}`,
          text: textBody,
        },
        order: {
          id: order.id,
          display_id: order.display_id,
          email: order.email,
          currency_code: order.currency_code,
        },
        shippingAddress: order.shipping_address,
        refundAmount,
        refundedAt,
        reason,
        preview: 'Uw terugstorting is verwerkt',
      },
    })
  } catch (error) {
    logger.error(
      `payment.refunded: failed to send notification for ${paymentId}: ${(error as Error).message}`
    )
    Sentry.captureException(error, {
      tags: { subscriber: 'payment.refunded' },
      extra: { paymentId },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'payment.refunded',
}
