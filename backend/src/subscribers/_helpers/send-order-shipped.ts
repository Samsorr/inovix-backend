import { Logger } from '@medusajs/framework/types'
import { sendEmailNotification } from '../../modules/email-notifications/send-notification'
import {
  applyOverrides,
  composeOrderShipped,
  type ComposeSkipReason,
} from '../../lib/order-email-compose'

export type SendOrderShippedResult = {
  sent: boolean
  /** Why nothing was sent. `already_sent` means the customer already has it. */
  reason?: string
}

/**
 * The payload itself is built by `composeOrderShipped` so the admin "edit
 * before send" path mails exactly what the automatic senders mail. This helper
 * owns the policy around it: the skip conditions, the idempotency key and the
 * trigger type.
 */
function skipMessage(
  reason: ComposeSkipReason | undefined,
  fulfillmentId: string,
  orderId: string | undefined
): string {
  switch (reason) {
    case 'no_order_link':
      return `sendOrderShippedNotification: no order link found for fulfillment ${fulfillmentId}; skipping notification`
    case 'no_email':
      return `sendOrderShippedNotification: order ${orderId} has no email; skipping notification`
    case 'no_shipping_address':
      return `sendOrderShippedNotification: order ${orderId} has no shipping_address; skipping notification`
    case 'fulfillment_not_found':
      return `sendOrderShippedNotification: fulfillment ${fulfillmentId} not found on order ${orderId}; skipping`
    case 'no_tracked_label':
      return `sendOrderShippedNotification: fulfillment ${fulfillmentId} has no tracked label; skipping notification`
    case 'order_not_found':
    default:
      return `sendOrderShippedNotification: no order found for fulfillment ${fulfillmentId}; skipping notification`
  }
}

export async function sendOrderShippedNotification(
  container: any,
  fulfillmentId: string,
  opts?: {
    noNotification?: boolean
    orderId?: string
    forceResend?: boolean
    /** Operator-edited copy, already validated. Empty means "not edited". */
    overrides?: Record<string, string>
  }
): Promise<SendOrderShippedResult> {
  const logger: Logger = container.resolve('logger')

  if (opts?.noNotification) {
    logger.info(
      `sendOrderShippedNotification: no_notification flag set for fulfillment ${fulfillmentId}; skipping`
    )
    return { sent: false, reason: 'no_notification' }
  }

  // `requireTracking: false` keeps the automatic behaviour: a shipment without
  // a tracked label still mails the customer today (manually fulfilled orders
  // have no DHL label), and refusing to compose would silently stop that mail.
  const composed = await composeOrderShipped(container, fulfillmentId, {
    orderId: opts?.orderId,
    requireTracking: false,
  })

  if (!composed.email) {
    logger.warn(skipMessage(composed.reason, fulfillmentId, composed.orderId))
    return { sent: false, reason: composed.reason }
  }

  const overrides =
    opts?.overrides && Object.keys(opts.overrides).length > 0
      ? opts.overrides
      : null
  const data = overrides
    ? applyOverrides(composed.email.data, overrides)
    : composed.email.data

  // Automatic producers (shipment.created subscriber, auto-mark-shipped cron,
  // the first click of the admin button) share one key so the customer gets
  // exactly one mail. A deliberate operator resend passes `forceResend` and
  // gets a unique key, because the whole point is to send it AGAIN. Without
  // this the button was a silent no-op: the module skips any key that already
  // exists with a non-failure status, and the route still answered 200. An
  // edited send is a deliberate resend too, so it also gets a unique key.
  const base = composed.email.idempotencyKeyBase
  const idempotencyKey = overrides
    ? `${base}-edited-${Date.now()}`
    : opts?.forceResend
      ? `${base}-resend-${Date.now()}`
      : base

  const outcome = await sendEmailNotification(container, {
    to: composed.email.to,
    channel: 'email',
    template: composed.email.template,
    idempotency_key: idempotencyKey,
    resource_id: composed.email.resourceId,
    resource_type: 'order',
    // Three automatic producers share this path (the shipment.created
    // subscriber, the auto-mark-shipped cron and the admin button's first
    // click), so do not claim a specific event here.
    trigger_type: overrides
      ? 'admin.edited'
      : opts?.forceResend
        ? 'admin.resend'
        : 'order.shipped',
    data,
  })

  return { sent: outcome.sent, ...(outcome.reason ? { reason: outcome.reason } : {}) }
}
