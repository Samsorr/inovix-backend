import { Modules } from '@medusajs/framework/utils'
import { INotificationModuleService, IOrderModuleService, Logger } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'

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

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL

    await notificationModuleService.createNotifications({
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_PLACED,
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: `Bestelling ontvangen | Inovix ${order.display_id}`,
        },
        order,
        shippingAddress: order.shipping_address,
        preview: 'Bedankt voor uw bestelling bij Inovix',
      },
    })
  } catch (error) {
    logger.error(`order.placed: failed to send notification for ${data.id}: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
