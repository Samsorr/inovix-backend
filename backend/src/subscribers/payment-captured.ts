import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { INotificationModuleService, Logger } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'
import { buildOrderConfirmationText } from './_helpers/order-confirmation-text'

export default async function paymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const notificationModuleService: INotificationModuleService = container.resolve(Modules.NOTIFICATION)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger: Logger = container.resolve('logger')

  const paymentId = data.id

  try {
    const { data: payments } = await query.graph({
      entity: 'payment',
      filters: { id: paymentId },
      fields: [
        'id',
        'payment_collection.id',
        'payment_collection.order.id',
        'payment_collection.order.display_id',
        'payment_collection.order.email',
        'payment_collection.order.currency_code',
        'payment_collection.order.created_at',
        'payment_collection.order.items.*',
        'payment_collection.order.summary.*',
        'payment_collection.order.shipping_address.*',
      ],
    })

    const order = payments?.[0]?.payment_collection?.order

    if (!order) {
      logger.warn(
        `payment.captured: no order found for payment ${paymentId}; confirmation will be sent on order.placed if the order materializes later`
      )
      return
    }

    if (!order.email) {
      logger.warn(`payment.captured: order ${order.id} has no email; skipping notification`)
      return
    }

    if (!order.shipping_address) {
      logger.warn(`payment.captured: order ${order.id} has no shipping_address; skipping notification`)
      return
    }

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const textBody = buildOrderConfirmationText(order, order.shipping_address)

    await notificationModuleService.createNotifications({
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_PLACED,
      idempotency_key: `order-confirmed-${order.id}`,
      resource_id: order.id,
      resource_type: 'order',
      trigger_type: 'payment.captured',
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: `Bestelling bevestigd | Inovix ${order.display_id}`,
          text: textBody,
        },
        order,
        shippingAddress: order.shipping_address,
        preview: 'Uw betaling is verwerkt | bestelling bevestigd',
      },
    })
  } catch (error) {
    logger.error(
      `payment.captured: failed to send notification for payment ${paymentId}: ${(error as Error).message}`
    )
    Sentry.captureException(error, {
      tags: { subscriber: 'payment.captured' },
      extra: { paymentId },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'payment.captured',
}
