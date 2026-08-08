import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { IOrderModuleService, Logger, MedusaContainer } from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { sendEmailNotification } from '../modules/email-notifications/send-notification'
import { Sentry } from '../lib/instrument'
import { resolveOrderEmailLocale } from '../lib/email-locale'
import {
  ORDER_CANCELLED_I18N,
  toEmailNumber,
  type OrderCancelledRefundState,
} from '../modules/email-notifications/templates/email-i18n'

export type OrderMoneyState = {
  state: OrderCancelledRefundState
  /** The amount the email should show, in the order currency. */
  amount: number | null
}

/**
 * Decide what the cancellation email is allowed to say about the money.
 *
 * Pure, exported for tests. The email used to promise "het volledige bedrag
 * wordt teruggestort" unconditionally: 8 of those went out against 0 refunds,
 * one to an order with captured = 0. A customer who was never charged must not
 * be told a refund is coming.
 */
export function resolveOrderMoneyState(
  paymentCollections: Array<{
    captured_amount?: number | string | null
    refunded_amount?: number | string | null
  } | null> | null | undefined,
  orderTotal: number | string | null | undefined
): OrderMoneyState {
  let captured = 0
  let refunded = 0
  for (const pc of paymentCollections ?? []) {
    if (!pc) continue
    captured += Number(pc.captured_amount ?? 0) || 0
    refunded += Number(pc.refunded_amount ?? 0) || 0
  }

  const total = orderTotal == null ? null : Number(orderTotal)
  const fallbackTotal = Number.isFinite(total as number) ? (total as number) : null

  // Nothing was ever taken: no refund, and say so.
  if (!(captured > 0)) {
    return { state: 'not_charged', amount: fallbackTotal }
  }

  const outstanding = captured - refunded

  // Everything captured is already back with the customer.
  if (!(outstanding > 0)) {
    return { state: 'refunded', amount: refunded > 0 ? refunded : captured }
  }

  return { state: 'refund_pending', amount: outstanding }
}

async function readMoneyState(
  container: MedusaContainer,
  orderId: string,
  orderTotal: number | string | null | undefined
): Promise<OrderMoneyState> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  // Same approach as order-placed: `order.payment_status` is unreliable at
  // subscriber time, so read the linked payment collection directly.
  const { data: orders } = await query.graph({
    entity: 'order',
    filters: { id: orderId },
    fields: [
      'id',
      'payment_collections.status',
      'payment_collections.captured_amount',
      'payment_collections.refunded_amount',
    ],
  })
  const collections = (orders?.[0] as any)?.payment_collections
  return resolveOrderMoneyState(collections, orderTotal)
}

export default async function orderCancelledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
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

    const locale = await resolveOrderEmailLocale(container, order.id)
    const base = ORDER_CANCELLED_I18N[locale] ?? ORDER_CANCELLED_I18N.nl
    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const addr = order.shipping_address
    const currency = (order.currency_code ?? 'EUR').toUpperCase()

    const orderTotal = (order as any).summary?.raw_current_order_total?.value
    const money = await readMoneyState(container, order.id, orderTotal)
    const t = base[money.state] ?? base.refund_pending

    logger.info(
      `order.canceled: order ${order.id} money state = ${money.state}; sending the matching cancellation copy`
    )

    const itemsText = (order.items ?? [])
      .map((item: any) => {
        const variant = item.variant_title ? ` | ${item.variant_title}` : ''
        const lineTotal = (
          toEmailNumber(item.unit_price) * toEmailNumber(item.quantity)
        ).toFixed(2)
        return `- ${item.product_title}${variant} × ${item.quantity} (${lineTotal} ${currency})`
      })
      .join('\n')

    const amountText =
      money.amount != null ? `${toEmailNumber(money.amount).toFixed(2)} ${currency}` : ''

    const textBody =
      `${base.heading}\n` +
      `${base.orderNumber} #${order.display_id}\n\n` +
      `${base.greeting} ${addr.first_name} ${addr.last_name},\n\n` +
      `${t.body(order.display_id)}\n\n` +
      `${base.cancelledItems}:\n${itemsText}\n\n` +
      (amountText
        ? `${t.amountLabel}: ${amountText} (${base.inclVat})\n\n`
        : '') +
      `${t.whenHeading}\n` +
      `${t.whenBody1}\n` +
      `${t.whenBody2}`

    await sendEmailNotification(container, {
      to: order.email,
      channel: 'email',
      template: EmailTemplates.ORDER_CANCELLED,
      // Was missing entirely, so a re-cancel or a re-emitted event sent a
      // second "your money is coming back" email.
      idempotency_key: `order-cancelled-${order.id}`,
      resource_id: order.id,
      resource_type: 'order',
      trigger_type: 'order.canceled',
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: base.subject(order.display_id),
          text: textBody,
        },
        order,
        shippingAddress: order.shipping_address,
        locale,
        preview: base.preview,
        refundState: money.state,
        refundAmount: money.amount,
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
