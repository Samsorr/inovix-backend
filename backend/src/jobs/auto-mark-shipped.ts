import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Sentry } from "../lib/instrument"
import { fetchDhlTracking, mapDhlTracking } from "../lib/dhl-tracking"
import { markDhlOrderShipped } from "../lib/mark-dhl-shipped"

// Every 30 minutes: any order whose DHL label exists (packed) but was never
// marked shipped gets checked against DHL's public track-trace. The moment
// DHL has physically scanned the parcel (handed_to_dhl), the order is marked
// shipped and the customer gets the tracking email | the exact same flow as
// the manual "Markeer als verzonden & mail klant" button, which stays as the
// manual backup. Kills the forgotten-tracking-email failure mode (bit us on
// order 28417: parcel at DHL for hours, customer never mailed).

const ORDER_FIELDS = [
  "id",
  "status",
  "shipping_address.postal_code",
  "fulfillments.id",
  "fulfillments.provider_id",
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  "fulfillments.data",
]

// Cap DHL lookups per tick; at 48 ticks/day this is plenty of headroom for
// Inovix volume and stays polite toward the public API.
const MAX_LOOKUPS_PER_TICK = 30

export type AutoShipOrderRow = {
  id: string
  status?: string | null
  shipping_address?: { postal_code?: string | null } | null
  // Live relation arrays can contain null elements (commit 9d7e9fa).
  fulfillments?: Array<{
    id: string
    provider_id?: string | null
    packed_at?: string | Date | null
    shipped_at?: string | Date | null
    canceled_at?: string | Date | null
    data?: Record<string, unknown> | null
  } | null> | null
}

export type AutoShipCandidate = {
  order_id: string
  tracking_number: string
  postal_code: string | null
}

export type SelectAutoShipOptions = {
  /** Called with the order id (and the error) for a row that could not be read. */
  onSkip?: (orderId: string, err: unknown) => void
}

// Pure selection, exported for tests: packed + unshipped + non-canceled DHL
// fulfillment with a tracking number, on a non-canceled order.
export function selectAutoShipCandidates(
  rows: AutoShipOrderRow[],
  opts: SelectAutoShipOptions = {}
): AutoShipCandidate[] {
  const out: AutoShipCandidate[] = []
  for (const row of rows ?? []) {
    // This runs OUTSIDE the per-candidate try/catch below, so one malformed
    // order used to kill the whole tracking-email cron.
    try {
      if (!row) continue
      if (row.status === "canceled" || row.status === "draft" || row.status === "archived") {
        continue
      }
      // Live relation arrays can hold null elements; filter before reading.
      const active = (row.fulfillments ?? []).filter(Boolean).find(
        (f) =>
          !f!.canceled_at &&
          !f!.shipped_at &&
          f!.packed_at &&
          (f!.provider_id === "dhl-parcel_dhl-parcel" ||
            typeof f!.data?.dhl_tracking_number === "string")
      )
      const tracking = active?.data?.dhl_tracking_number
      if (!active || typeof tracking !== "string" || !tracking) continue
      out.push({
        order_id: row.id,
        tracking_number: tracking,
        postal_code: row.shipping_address?.postal_code ?? null,
      })
    } catch (err) {
      opts.onSkip?.(String((row as { id?: unknown } | null)?.id ?? "unknown"), err)
    }
  }
  return out
}

export default async function autoMarkShipped(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (m: string) => void
    warn: (m: string) => void
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    pagination: { take: 300, skip: 0, order: { created_at: "DESC" } },
  })

  const candidates = selectAutoShipCandidates((data ?? []) as AutoShipOrderRow[], {
    onSkip: (orderId, err) =>
      logger.warn(
        `[auto-mark-shipped] skipped unreadable order ${orderId}: ${(err as Error)?.message}`
      ),
  }).slice(0, MAX_LOOKUPS_PER_TICK)
  if (candidates.length === 0) {
    return
  }

  let shipped = 0
  for (const c of candidates) {
    try {
      const raw = await fetchDhlTracking(c.tracking_number, c.postal_code)
      if (!raw) continue
      const view = mapDhlTracking(raw)
      if (!view.handed_to_dhl) continue

      const result = await markDhlOrderShipped(container, c.order_id)
      if (result.ok && !result.already_shipped) {
        shipped++
        logger.info(
          `[auto-mark-shipped] DHL scanned ${c.tracking_number}; marked order ${c.order_id} shipped + mailed customer`
        )
      }
    } catch (err) {
      logger.warn(
        `[auto-mark-shipped] failed for order ${c.order_id} (non-fatal): ${(err as Error).message}`
      )
      Sentry.captureException(err, {
        tags: { job: "auto-mark-shipped" },
        extra: { order_id: c.order_id },
      })
    }
  }

  logger.info(
    `[auto-mark-shipped] checked ${candidates.length} packed order(s) against DHL, auto-shipped ${shipped}`
  )
}

export const config = {
  name: "auto-mark-shipped",
  // every 30 minutes
  schedule: "*/30 * * * *",
}
