import { Modules } from '@medusajs/framework/utils'
import {
  INotificationModuleService,
  IOrderModuleService,
  Logger,
} from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'

export default async function orderCancelledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const notificationModuleService: INotificationModuleService = container.resolve(
    Modules.NOTIFICATION
  )
  const orderModuleService: IOrderModuleService = container.resolve(Modules.ORDER)
  const logger: Logger = container.resolve('logger')

  try {
    const order = await orderModuleService.retrieveOrder(data.id, {
      relations: ['items', 'summary', 'shipping_address'],
    })

    if (!order.email) {
      logger.warn(
        `order.canceled: order ${data.id} has no email; skipping notification`
      )
      return
    }

    if (!order.shipping_address) {
      logger.warn(
        `order.canceled: order ${data.id} has no shipping_address; skipping notification`
      )
      return
    }

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const addr = order.shipping_address
    const currency = (order.currency_code ?? 'EUR').toUpperCase()
    const itemsText = (order.items ?? [])
      .map((item: any) => {
        const variant = item.variant_title ? ` | ${item.variant_title}` : ''
        const lineTotal = ((item.unit_price ?? 0) * (item.quantity ?? 0)).toFixed(2)
        return `- ${item.product_title}${variant} × ${item.quantity} (${lineTotal} ${currency})`
      })
      .join('\n')
    const refundValue = order.summary?.raw_current_order_total?.value
    const refundText =
      refundValue != null ? `${Number(refundValue).toFixed(2)} ${currency}` : ''

    const textBody =
      `Uw bestelling is geannuleerd\n` +
      `Ordernummer #${order.display_id}\n\n` +
      `Beste ${addr.first_name} ${addr.last_name},\n\n` +
      `We bevestigen dat uw bestelling #${order.display_id} is geannuleerd. ` +
      `Het volledige bedrag wordt teruggestort naar de oorspronkelijke betaalmethode.\n\n` +
      `Geannuleerde artikelen:\n${itemsText}\n\n` +
      (refundText
        ? `Terug te storten bedrag: ${refundText} (incl. btw en verzendkosten)\n\n`
        : '') +
      `Wanneer ontvangt u uw geld terug?\n` +
      `De terugstorting wordt direct in gang gezet. Afhankelijk van uw bank ` +
      `of kaartuitgever kan het 5 tot 10 werkdagen duren voordat het bedrag op ` +
      `uw rekening zichtbaar is. Heeft u na 10 werkdagen nog niets ontvangen, ` +
      `neem dan contact met ons op.`

    await notificationModuleService.createNotifications({
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_CANCELLED,
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: `Bestelling geannuleerd | Inovix ${order.display_id}`,
          text: textBody,
        },
        order,
        shippingAddress: order.shipping_address,
        preview: 'Uw bestelling is geannuleerd',
      },
    })
  } catch (error) {
    logger.error(
      `order.canceled: failed to send notification for ${data.id}: ${(error as Error).message}`
    )
    Sentry.captureException(error, {
      tags: { subscriber: 'order.canceled' },
      extra: { orderId: data.id },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'order.canceled',
}
