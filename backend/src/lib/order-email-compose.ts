import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

import { EmailTemplates } from '../modules/email-notifications/templates'
import {
  ORDER_PLACED_I18N,
  ORDER_SHIPPED_I18N,
} from '../modules/email-notifications/templates/email-i18n'
import { buildOrderConfirmationText } from '../subscribers/_helpers/order-confirmation-text'
import { resolveOrderEmailLocale } from './email-locale'
import type { EmailLocale } from './email-locale'

/**
 * One place that builds an order email payload.
 *
 * The automatic senders (the shipment.created subscriber, the auto-mark-shipped
 * cron, the order.placed subscriber) and the admin "edit before send" composer
 * all go through here. If the admin path built its own payload the edited mail
 * would be assembled by different code than the automatic one and the two would
 * silently drift apart, which is exactly what this module exists to prevent.
 *
 * A composer builds a payload and nothing else: it does not send, it does not
 * pick the final idempotency key (only the base) and it does not set
 * `trigger_type`. Those are policy and stay with the caller.
 */

type ContainerLike = { resolve: (key: string) => any }

export type ComposedEmail = {
  to: string
  template: string
  locale: EmailLocale
  /** Exactly the `data` payload the senders pass to sendEmailNotification. */
  data: Record<string, any>
  /** `order-shipped-<fulfillmentId>` | `order-confirmed-<orderId>`. */
  idempotencyKeyBase: string
  resourceId: string
  replyTo?: string
}

/** Why an email could not be composed. */
export type ComposeSkipReason =
  | 'no_order_link'
  | 'order_not_found'
  | 'no_email'
  | 'no_shipping_address'
  | 'fulfillment_not_found'
  | 'no_tracked_label'

/**
 * Flat result with optional fields on purpose: this repo's tsconfig runs
 * without strict mode, so negative-branch narrowing on a discriminated union
 * does not work.
 */
export type ComposeResult = {
  /** Present when the payload could be built. */
  email?: ComposedEmail
  /** Present when it could not. The caller owns the log line. */
  reason?: ComposeSkipReason
  /** The resolved order id when we got that far; callers name it when logging. */
  orderId?: string
}

export type ComposeOrderShippedOptions = {
  /** Skip the order_fulfillment link lookup when the caller knows the order. */
  orderId?: string
  /**
   * Refuse to compose when no label carries a tracking number. Default true,
   * which is what the admin composer wants: a tracking mail without a tracking
   * link is not worth offering.
   *
   * The automatic sender passes `false` deliberately. Today a shipment without
   * a label still mails the customer (a manually fulfilled order has no DHL
   * label), and turning that into a silent skip would be a behaviour change.
   */
  requireTracking?: boolean
}

function replyToAddress(): string | undefined {
  return process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
}

/**
 * Build the order-shipped payload for one fulfillment.
 *
 * Returns the flat result so a caller can map the skip reason onto its own log
 * line. `composeOrderShippedEmail` is the null-or-payload form.
 */
export async function composeOrderShipped(
  container: ContainerLike,
  fulfillmentId: string,
  opts?: ComposeOrderShippedOptions
): Promise<ComposeResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

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
    return { reason: 'no_order_link' }
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
    return { reason: 'order_not_found', orderId }
  }

  if (!order.email) {
    return { reason: 'no_email', orderId: order.id }
  }

  if (!order.shipping_address) {
    return { reason: 'no_shipping_address', orderId: order.id }
  }

  const fulfillment = order.fulfillments?.find(
    (f: { id: string }) => f.id === fulfillmentId
  )

  if (!fulfillment) {
    return { reason: 'fulfillment_not_found', orderId: order.id }
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

  if (
    opts?.requireTracking !== false &&
    !labels.some(
      (l: { tracking_number: string | null; tracking_url: string | null }) =>
        Boolean(l.tracking_number) || Boolean(l.tracking_url)
    )
  ) {
    return { reason: 'no_tracked_label', orderId: order.id }
  }

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
  const replyTo = replyToAddress()

  return {
    orderId: order.id,
    email: {
      to: order.email,
      template: EmailTemplates.ORDER_SHIPPED,
      locale,
      idempotencyKeyBase: `order-shipped-${fulfillmentId}`,
      resourceId: order.id,
      ...(replyTo ? { replyTo } : {}),
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
    },
  }
}

/** Null-or-payload form of `composeOrderShipped`, for the admin routes. */
export async function composeOrderShippedEmail(
  container: ContainerLike,
  fulfillmentId: string,
  opts?: ComposeOrderShippedOptions
): Promise<ComposedEmail | null> {
  const result = await composeOrderShipped(container, fulfillmentId, opts)
  return result.email ?? null
}

/**
 * Build the order-placed (confirmation) payload.
 *
 * The "only send once payment is captured" guard is NOT here: that is the
 * subscriber's policy, and the admin resend path deliberately does not want it.
 */
export async function composeOrderPlaced(
  container: ContainerLike,
  orderId: string
): Promise<ComposeResult> {
  const orderModuleService = container.resolve(Modules.ORDER)

  const order = await orderModuleService.retrieveOrder(orderId, {
    relations: ['items', 'summary', 'shipping_address'],
  })

  if (!order) {
    return { reason: 'order_not_found', orderId }
  }

  if (!order.shipping_address) {
    return { reason: 'no_shipping_address', orderId: order.id }
  }

  const locale = await resolveOrderEmailLocale(container, order.id)
  const t = ORDER_PLACED_I18N[locale]
  const replyTo = replyToAddress()
  const textBody = buildOrderConfirmationText(order as any, order.shipping_address as any, locale)

  return {
    orderId: order.id,
    email: {
      to: order.email,
      template: EmailTemplates.ORDER_PLACED,
      locale,
      idempotencyKeyBase: `order-confirmed-${order.id}`,
      resourceId: order.id,
      ...(replyTo ? { replyTo } : {}),
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: t.subject(order.display_id),
          text: textBody,
        },
        order,
        shippingAddress: order.shipping_address,
        locale,
        preview: t.preview,
      },
    },
  }
}

/** Null-or-payload form of `composeOrderPlaced`, for the admin routes. */
export async function composeOrderPlacedEmail(
  container: ContainerLike,
  orderId: string
): Promise<ComposedEmail | null> {
  const result = await composeOrderPlaced(container, orderId)
  return result.email ?? null
}

/**
 * Merge operator overrides into a composed payload.
 *
 * The preview route and the send path both call this, so what the operator sees
 * cannot diverge from what the customer gets.
 *
 * `subject` is special: the Resend provider reads it from `emailOptions`, so it
 * moves there and is REMOVED from `overrides`. Leaving it in both places would
 * invite the two copies to drift.
 */
export function applyOverrides(
  data: Record<string, any>,
  overrides: Record<string, string>
): Record<string, any> {
  // Annotated because a spread of Record<string, any> plus an explicit key
  // loses the index signature, and `next.overrides` would then not typecheck.
  const next: Record<string, any> = {
    ...data,
    emailOptions: { ...(data.emailOptions ?? {}) },
  }
  const rest: Record<string, string> = { ...overrides }

  // Stamp "edited" BEFORE the subject is moved out, and here rather than at
  // each call site. A subject-only edit empties `rest`, so no `overrides` key
  // is written and the sent-list badge would call a genuinely edited mail
  // unedited. One rule in one place: the preview and both send paths inherit
  // it, and they cannot disagree about what counts as edited.
  if (Object.keys(rest).length > 0) next.edited = true

  if (typeof rest.subject === 'string' && rest.subject.trim().length > 0) {
    next.emailOptions.subject = rest.subject
    delete rest.subject
  }
  if (Object.keys(rest).length > 0) next.overrides = rest
  return next
}
