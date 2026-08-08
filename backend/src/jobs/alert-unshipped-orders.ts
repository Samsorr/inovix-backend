import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { INotificationModuleService, Logger } from "@medusajs/framework/types"

import { EmailTemplates } from "../modules/email-notifications/templates"
import { Sentry } from "../lib/instrument"
import {
  buildVerzendstationQueues,
  QUEUE_ORDER_FIELDS,
  selectStaleUnshipped,
  type QueueEntry,
  type QueueOrderRow,
} from "../lib/verzendstation-queues"

// Orders whose DHL label was made this long ago without a "markeer als
// verzonden" click get flagged to the operator. Without that click the
// customer never receives the track-and-trace mail.
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function formatDutchDate(iso: string | null): string {
  if (!iso) return "onbekend"
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return "onbekend"
  return t.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })
}

// Pure mapping from stale queue entries to the notification payload. Exported
// for unit tests.
export function buildAlertPayload(stale: QueueEntry[], todayIso: string) {
  return {
    idempotency_key: `unshipped-orders-alert-${todayIso}`,
    data: {
      emailOptions: {
        subject: `Let op: ${stale.length} ingepakte bestelling(en) nog niet verzonden`,
      },
      orders: stale.map((e) => ({
        display_id: e.display_id != null ? String(e.display_id) : "?",
        customer_name: e.customer_name || "Onbekende klant",
        packed_at: formatDutchDate(e.packed_at),
      })),
    },
  }
}

// Daily 07:00 safety net: any order with a label made >24h ago that was never
// marked shipped gets ONE summary email to the operator. The per-day
// idempotency key makes reruns harmless.
export default async function alertUnshippedOrders(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger

  // Everything is wrapped: this job is the last line of defence against a
  // forgotten parcel, so a data quirk or a mail hiccup must degrade to "no
  // alert this run" (logged + reported) instead of throwing silently forever.
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const notifications = container.resolve(
      Modules.NOTIFICATION
    ) as INotificationModuleService

    // The Verzendstation queue page only shows the newest 200 orders; this
    // safety net must look further back so an order that scrolled off the
    // visible page doesn't silently skip the unshipped alert.
    const { data } = await query.graph({
      entity: "order",
      fields: QUEUE_ORDER_FIELDS,
      pagination: { take: 1000, skip: 0, order: { created_at: "DESC" } },
    })

    const queues = buildVerzendstationQueues((data ?? []) as QueueOrderRow[], {
      // One malformed order out of 1000 must not cost every other order its
      // alert; log it by id so it can be fixed.
      onSkip: (orderId, err) =>
        logger.warn(
          `[alert-unshipped-orders] skipped order ${orderId}: ${(err as Error)?.message}`
        ),
    })
    const stale = selectStaleUnshipped(queues, Date.now(), MAX_AGE_MS)
    if (stale.length === 0) {
      return
    }

    const to =
      process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL || "info@inovix.nl"
    const today = new Date().toISOString().slice(0, 10)
    const payload = buildAlertPayload(stale, today)

    await notifications.createNotifications({
      to,
      channel: "email",
      template: EmailTemplates.UNSHIPPED_ORDERS_ALERT,
      idempotency_key: payload.idempotency_key,
      trigger_type: "job.alert-unshipped-orders",
      data: payload.data,
    })

    logger.info(
      `[alert-unshipped-orders] alerted ${to} about ${stale.length} unshipped order(s)`
    )
  } catch (err) {
    logger.error(
      `[alert-unshipped-orders] run failed, no alert sent: ${(err as Error).message}`
    )
    Sentry.captureException(err, { tags: { job: "alert-unshipped-orders" } })
  }
}

export const config = {
  name: "alert-unshipped-orders",
  // daily 05:00 UTC = 07:00 Amsterdam in summer, 06:00 in winter (Railway cron runs UTC)
  schedule: "0 5 * * *",
}
