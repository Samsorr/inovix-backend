import { Modules } from '@medusajs/framework/utils'
import { INotificationModuleService, IOrderModuleService, Logger } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'
import { buildOrderConfirmationText } from './_helpers/order-confirmation-text'

export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const notificationModuleService: INotificationModuleService = container.resolve(Modules.NOTIFICATION)
  const orderModuleService: IOrderModuleService = container.resolve(Modules.ORDER)
  const logger: Logger = container.resolve('logger')

  try {
    const order = await orderModuleService.retrieveOrder(data.id, {
      relations: ['items', 'summary', 'shipping_address'],
    })

    if (!order.shipping_address) {
      logger.warn(`order.placed: order ${data.id} has no shipping_address; skipping notification`)
      return
    }

    // Only send the confirmation once payment has actually been captured.
    // In the Viva Smart Checkout redirect flow, order.placed fires before
    // the webhook captures the payment; the payment-captured subscriber
    // sends the email in that case. In the webhook-first flow, the order
    // is created after capture and this branch sends it.
    const paymentStatus = (order as { payment_status?: string }).payment_status
    if (paymentStatus !== 'captured') {
      logger.info(
        `order.placed: order ${order.id} payment_status=${paymentStatus}; deferring email to payment.captured`
      )
      return
    }

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const textBody = buildOrderConfirmationText(order as any, order.shipping_address as any)

    await notificationModuleService.createNotifications({
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_PLACED,
      idempotency_key: `order-confirmed-${order.id}`,
      resource_id: order.id,
      resource_type: 'order',
      trigger_type: 'order.placed',
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
    logger.error(`order.placed: failed to send notification for ${data.id}: ${(error as Error).message}`)
    Sentry.captureException(error, {
      tags: { subscriber: 'order.placed' },
      extra: { orderId: data.id },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
