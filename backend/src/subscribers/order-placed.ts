import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { IOrderModuleService, Logger } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { sendEmailNotification } from '../modules/email-notifications/send-notification'
import { Sentry } from '../lib/instrument'
import { composeOrderPlaced } from '../lib/order-email-compose'

export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderModuleService: IOrderModuleService = container.resolve(Modules.ORDER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
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
    // `order.payment_status` is often undefined at the time this subscriber
    // fires because the order/payment link is still committing, so read the
    // linked payment collection via the order entity (payment_collection is
    // a remote link, not a direct foreign key on payment_collection itself).
    const { data: orders } = await query.graph({
      entity: 'order',
      filters: { id: data.id },
      fields: [
        'id',
        'payment_collections.status',
        'payment_collections.captured_amount',
      ],
    })
    const orderWithCollections = orders?.[0] as
      | {
          payment_collections?: Array<{
            status?: string
            captured_amount?: number
          }>
        }
      | undefined
    const paymentCollection = orderWithCollections?.payment_collections?.[0]
    const isPaid =
      paymentCollection?.status === 'completed' ||
      Number(paymentCollection?.captured_amount ?? 0) > 0

    if (!isPaid) {
      logger.info(
        `order.placed: order ${order.id} payment_collection status=${paymentCollection?.status ?? 'missing'}; deferring email to payment.captured`
      )
      return
    }

    // The payload lives in the shared composer so the admin "edit before send"
    // path mails exactly what this subscriber mails. The key policy and the
    // trigger type stay here.
    const composed = await composeOrderPlaced(container, order.id)
    if (!composed.email) {
      logger.warn(
        `order.placed: could not compose the confirmation for ${data.id} (${composed.reason}); skipping notification`
      )
      return
    }

    await sendEmailNotification(container, {
      to: composed.email.to,
      channel: 'email',
      template: composed.email.template,
      idempotency_key: composed.email.idempotencyKeyBase,
      resource_id: composed.email.resourceId,
      resource_type: 'order',
      trigger_type: 'order.placed',
      data: composed.email.data,
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
