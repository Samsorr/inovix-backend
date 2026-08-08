import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { Logger } from '@medusajs/framework/types'
import { EmailTemplates } from '../../modules/email-notifications/templates'
import { sendEmailNotification } from '../../modules/email-notifications/send-notification'
import { resolveOrderEmailLocale } from '../../lib/email-locale'
import { ORDER_SHIPPED_I18N } from '../../modules/email-notifications/templates/email-i18n'

export type SendOrderShippedResult = {
  sent: boolean
  /** Why nothing was sent. `already_sent` means the customer already has it. */
  reason?: string
}

export async function sendOrderShippedNotification(
  container: any,
  fulfillmentId: string,
  opts?: { noNotification?: boolean; orderId?: string; forceResend?: boolean }
): Promise<SendOrderShippedResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger: Logger = container.resolve('logger')

  if (opts?.noNotification) {
    logger.info(
      `sendOrderShippedNotification: no_notification flag set for fulfillment ${fulfillmentId}; skipping`
    )
    return { sent: false, reason: 'no_notification' }
  }

  // Resolve the order id first. Filtering orders on `fulfillments.id`
  // (cross-module link path) generates broken SQL on Medusa 2.12 ("missing
  // FROM-clause entry for table fulfillments") | it silently killed EVERY
  // shipped email. Callers that know the order id pass it; the
  // shipment.created subscriber resolves it via the link table.
  let orderId = opts?.orderId ?? null
  if (!orderId) {
    const { data: links } = await query.graph({
      entity: 'order_fulfillment',
      filters: { fulfillment_id: fulfillmentId },
      fields: ['order_id'],
    })
    orderId = (links?.[0] as { order_id?: string } | undefined)?.order_id ?? null
  }
  if (!orderId) {
    logger.warn(
      `sendOrderShippedNotification: no order link found for fulfillment ${fulfillmentId}; skipping notification`
    )
    return { sent: false, reason: 'no_order_link' }
  }

  const { data: orders } = await query.graph({
    entity: 'order',
    filters: { id: orderId },
    fields: [
      'id',
      'display_id',
      'email',
      'currency_code',
      'shipping_address.*',
      'items.id',
      'items.title',
      'items.product_title',
      'items.variant_title',
      'fulfillments.id',
      'fulfillments.shipped_at',
      'fulfillments.labels.tracking_number',
      'fulfillments.labels.tracking_url',
      'fulfillments.labels.label_url',
      'fulfillments.items.id',
      'fulfillments.items.line_item_id',
      'fulfillments.items.quantity',
    ],
  })

  const order = orders?.[0]

  if (!order) {
    logger.warn(
      `sendOrderShippedNotification: no order found for fulfillment ${fulfillmentId}; skipping notification`
    )
    return { sent: false, reason: 'order_not_found' }
  }

  if (!order.email) {
    logger.warn(
      `sendOrderShippedNotification: order ${order.id} has no email; skipping notification`
    )
    return { sent: false, reason: 'no_email' }
  }

  if (!order.shipping_address) {
    logger.warn(
      `sendOrderShippedNotification: order ${order.id} has no shipping_address; skipping notification`
    )
    return { sent: false, reason: 'no_shipping_address' }
  }

  const fulfillment = order.fulfillments?.find(
    (f: { id: string }) => f.id === fulfillmentId
  )

  if (!fulfillment) {
    logger.warn(
      `sendOrderShippedNotification: fulfillment ${fulfillmentId} not found on order ${order.id}; skipping`
    )
    return { sent: false, reason: 'fulfillment_not_found' }
  }

  const fulfillmentLineItemIds = new Set(
    (fulfillment.items ?? [])
      .map((fi: { line_item_id?: string | null }) => fi.line_item_id)
      .filter((id: string | null | undefined): id is string => Boolean(id))
  )

  const shipmentItems = (order.items ?? [])
    .filter((item: { id: string }) => fulfillmentLineItemIds.has(item.id))
    .map(
      (item: {
        id: string
        product_title?: string | null
        variant_title?: string | null
        title?: string | null
      }) => {
        const fItem = (fulfillment.items ?? []).find(
          (fi: { line_item_id?: string | null }) =>
            fi.line_item_id === item.id
        )
        const title = item.product_title
          ? item.variant_title
            ? `${item.product_title} | ${item.variant_title}`
            : item.product_title
          : item.title ?? 'Artikel'
        return {
          id: item.id,
          title,
          quantity: fItem?.quantity ?? 0,
        }
      }
    )

  const labels = (fulfillment.labels ?? []).map(
    (l: {
      tracking_number?: string | null
      tracking_url?: string | null
      label_url?: string | null
    }) => ({
      tracking_number: l.tracking_number ?? null,
      tracking_url: l.tracking_url ?? null,
      label_url: l.label_url ?? null,
    })
  )

  const locale = await resolveOrderEmailLocale(container, order.id)
  const t = ORDER_SHIPPED_I18N[locale]

  // Match the DHL portal language to the email language. Only the lang query
  // param changes; the barcode/postcode deep link stays as stored.
  const portalLang = locale === "de" ? "de_DE" : locale === "en" ? "en_GB" : "nl_NL"
  for (const label of labels) {
    if (label.tracking_url?.includes("my.dhlecommerce.nl")) {
      label.tracking_url = label.tracking_url.replace(/lang=[A-Za-z_]+/, `lang=${portalLang}`)
    }
  }
  const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL

  // Automatic producers (shipment.created subscriber, auto-mark-shipped cron,
  // the first click of the admin button) share one key so the customer gets
  // exactly one mail. A deliberate operator resend passes `forceResend` and
  // gets a unique key, because the whole point is to send it AGAIN. Without
  // this the button was a silent no-op: the module skips any key that already
  // exists with a non-failure status, and the route still answered 200.
  const idempotencyKey = opts?.forceResend
    ? `order-shipped-${fulfillmentId}-resend-${Date.now()}`
    : `order-shipped-${fulfillmentId}`

  const outcome = await sendEmailNotification(container, {
    to: order.email,
    channel: 'email',
    template: EmailTemplates.ORDER_SHIPPED,
    idempotency_key: idempotencyKey,
    resource_id: order.id,
    resource_type: 'order',
    // Three automatic producers share this path (the shipment.created
    // subscriber, the auto-mark-shipped cron and the admin button's first
    // click), so do not claim a specific event here.
    trigger_type: opts?.forceResend ? 'admin.resend' : 'order.shipped',
    data: {
      emailOptions: {
        ...(replyTo ? { replyTo } : {}),
        subject: t.subject(order.display_id),
      },
      order: {
        id: order.id,
        display_id: order.display_id,
        email: order.email,
        currency_code: order.currency_code,
      },
      shippingAddress: order.shipping_address,
      labels,
      items: shipmentItems,
      shippedAt: fulfillment.shipped_at ?? null,
      locale,
      preview: t.preview,
    },
  })

  return { sent: outcome.sent, ...(outcome.reason ? { reason: outcome.reason } : {}) }
}
