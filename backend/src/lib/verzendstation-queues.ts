// Pure derivation of the Verzendstation queues from order rows loaded via
// query.graph. query.graph cannot compute fulfillment_status, so paid /
// packed / shipped are derived here from the broker payment amounts and the
// fulfillment timestamps. Shared by the queue API route and the daily
// unshipped-orders alert job.

import { customerNoteFromOrder } from "../admin/widgets/customer-note.logic"
import {
  evaluatePaymentGate,
  hasOverride,
  parseChecklist,
} from "../admin/widgets/order-fulfillment-checklist.logic"
import { normalizeBrokerPayment } from "../admin/widgets/order-payment-broker.logic"
import {
  itemQuantity,
  ITEM_QUANTITY_FIELDS,
  type ItemQuantityShape,
} from "./item-quantity"

const BROKER_PROVIDER_ID = "pp_via_broker_via_broker"

// The exact field list callers must pass to query.graph (entity: "order").
// Trailing-star rules apply; shipping_option is never traversed.
export const QUEUE_ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "created_at",
  "email",
  "metadata",
  "shipping_address.first_name",
  "shipping_address.last_name",
  "items.id",
  // items.quantity alone comes back undefined on live data (the value sits on
  // items.detail); all four shapes are resolved by itemQuantity.
  ...ITEM_QUANTITY_FIELDS,
  "fulfillments.id",
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  // Payment has NO captured_amount/refunded_amount fields (query.graph
  // returns undefined for unknown fields, silently). The real amounts are
  // the capture/refund rows, summed via normalizeBrokerPayment.
  "payment_collections.payments.provider_id",
  "payment_collections.payments.amount",
  "payment_collections.payments.raw_amount",
  "payment_collections.payments.canceled_at",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.refunds.amount",
]

export type QueueOrderRow = {
  id: string
  display_id?: number | null
  status?: string | null
  created_at?: string | Date | null
  email?: string | null
  metadata?: Record<string, unknown> | null
  shipping_address?: {
    first_name?: string | null
    last_name?: string | null
  } | null
  // Every relation array can contain null elements on live data (commit
  // 9d7e9fa), hence the `| null` on the element types.
  items?: Array<(ItemQuantityShape & { id: string }) | null> | null
  fulfillments?: Array<{
    id: string
    packed_at?: string | Date | null
    shipped_at?: string | Date | null
    canceled_at?: string | Date | null
  } | null> | null
  payment_collections?: Array<{
    payments?: Array<{
      provider_id?: string | null
      amount?: unknown
      raw_amount?: unknown
      canceled_at?: string | Date | null
      captures?: Array<{ amount?: unknown }> | null
      refunds?: Array<{ amount?: unknown }> | null
    } | null> | null
  } | null> | null
}

export type QueueEntry = {
  id: string
  display_id: number | null
  customer_name: string
  item_count: number
  created_at: string | null
  packed_at: string | null
  /** The customer's checkout remark, null when they left none. */
  customer_note: string | null
}

export type AttentionReasonCode = "payment_unconfirmed" | "manual_fulfillment"

/**
 * Why an order landed in the "Aandacht nodig" bucket instead of a work queue,
 * in Dutch and ready to render. `label` names the problem, `action` names the
 * next step, so the operator never has to guess what the bucket means.
 */
export type AttentionReason = {
  code: AttentionReasonCode
  label: string
  action: string
}

export type AttentionEntry = QueueEntry & {
  /** Never empty: an entry only exists here because at least one check failed. */
  reasons: AttentionReason[]
}

export type VerzendstationQueues = {
  to_process: QueueEntry[]
  to_ship: QueueEntry[]
  /**
   * Orders that are NOT normal pick work but must never be invisible either:
   * a paid order whose Medusa capture row is missing, a refund landing after
   * the label was bought, a fulfillment created with Medusa's native "Fulfill
   * items" button. Before this bucket existed these rows were `continue`d
   * past, which removed them from the Verzendstation page, the daily unshipped
   * email and the hourly Telegram reminder at the same moment.
   */
  needs_attention: AttentionEntry[]
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

function toEntry(row: QueueOrderRow, packedAt: string | null): QueueEntry {
  const a = row.shipping_address ?? {}
  return {
    id: row.id,
    display_id: row.display_id ?? null,
    customer_name:
      `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || (row.email ?? ""),
    item_count: (row.items ?? [])
      .filter(Boolean)
      .reduce((n, i) => n + (itemQuantity(i) ?? 0), 0),
    created_at: iso(row.created_at),
    packed_at: packedAt,
    customer_note: customerNoteFromOrder(row),
  }
}

// The payment gate's own Dutch reason is reused verbatim ("De betaling is nog
// niet (volledig) ontvangen", "Er is (deels) terugbetaald op deze bestelling",
// ...) so the row says which of the four gate failures happened.
function paymentReason(gateReason: string | null): AttentionReason {
  return {
    code: "payment_unconfirmed",
    label: `Betaling niet bevestigd in Medusa: ${
      gateReason ?? "onbekende reden"
    }`,
    action:
      "De klant heeft betaald (een bestelling ontstaat pas na 'betaald'), maar Medusa heeft de betaling niet vastgelegd. Controleer de betaling op de bestelpagina voordat je verzendt.",
  }
}

// Our own DHL flow always stamps packed_at when it creates the fulfillment
// (create-dhl-parcel-shipment/steps/call-dhl.ts). A non-canceled fulfillment
// WITHOUT packed_at therefore comes from Medusa's native "Fulfill items"
// button, which consumes the items' fulfilled_quantity and used to delete the
// order from every operator surface.
const MANUAL_FULFILLMENT_REASON: AttentionReason = {
  code: "manual_fulfillment",
  label: "Handmatige fulfillment zonder DHL-label",
  action:
    "Er is een fulfillment aangemaakt met de knop 'Fulfill items' in plaats van met de verzendchecklist. Annuleer die fulfillment op de bestelpagina en maak het label via de checklist, anders krijgt de klant geen track-and-trace.",
}

export type BuildQueuesOptions = {
  /**
   * Called with the order id (and the error) for a row this function could not
   * process. Callers pass a logger so a malformed order is identifiable
   * instead of silently vanishing.
   */
  onSkip?: (orderId: string, err: unknown) => void
}

export function buildVerzendstationQueues(
  rows: QueueOrderRow[],
  opts: BuildQueuesOptions = {}
): VerzendstationQueues {
  const to_process: QueueEntry[] = []
  const to_ship: QueueEntry[] = []
  const needs_attention: AttentionEntry[] = []

  for (const row of rows ?? []) {
    // One malformed order must never take out the whole page: this function
    // feeds the Verzendstation queue AND the daily unshipped-orders alert, so
    // a throw here would hide every other order too.
    try {
      if (!row) continue
      if (row.status === "canceled" || row.status === "draft" || row.status === "archived") {
        continue
      }
      // Only non-canceled fulfillments count; an order with a shipped
      // fulfillment AND a fresh redo must not be hidden behind the shipped one,
      // so the open (= not yet shipped) ones drive everything below. Live
      // relation arrays can hold null elements (commit 9d7e9fa), so filter
      // before touching any element.
      const nonCanceled = (row.fulfillments ?? []).filter(
        (f): f is NonNullable<typeof f> => !!f && !f.canceled_at
      )
      const open = nonCanceled.filter((f) => !f.shipped_at)
      // Everything that exists is shipped: done, the customer has tracking.
      if (nonCanceled.length > 0 && open.length === 0) continue
      // Our DHL flow always stamps packed_at at creation (call-dhl.ts), so a
      // packed open fulfillment means a real label was bought.
      const packed = open.find((f) => !!f.packed_at) ?? null
      const manualOpen = open.find((f) => !f.packed_at) ?? null

      // Evaluated once per row: a refund after packing must pull the order out
      // of the ship queue (spec edge case) and into needs_attention, while a
      // logged payment override (e.g. a manual bank transfer) keeps
      // legitimately-overridden orders in the normal queues even though the
      // broker payment itself never went "ok".
      const payment = (row.payment_collections ?? [])
        .filter(Boolean)
        .flatMap((c) => c!.payments ?? [])
        .filter(Boolean)
        .find((p) => p!.provider_id === BROKER_PROVIDER_ID)
      const gate = evaluatePaymentGate(
        payment ? normalizeBrokerPayment(payment as never) : null
      )
      const paymentOverridden = hasOverride(parseChecklist(row.metadata), "payment")
      const paymentOk = gate.ok || paymentOverridden

      // Anything that is not clean work goes to needs_attention, never to
      // `continue`. An order the customer paid for must be visible somewhere.
      const reasons: AttentionReason[] = []
      // An open fulfillment without packed_at is a native "Fulfill items" one:
      // real work in progress, but not work this flow can carry (no label, no
      // tracking, no shipping mail), so the operator has to unpick it. When a
      // real label also exists the order still belongs in the ship queue, which
      // is where the action is, so only flag it when nothing was packed.
      if (!packed && manualOpen) reasons.push(MANUAL_FULFILLMENT_REASON)
      if (!paymentOk) reasons.push(paymentReason(gate.reason))

      if (reasons.length > 0) {
        needs_attention.push({
          ...toEntry(row, packed ? iso(packed.packed_at) : null),
          reasons,
        })
        continue
      }

      if (packed) {
        to_ship.push(toEntry(row, iso(packed.packed_at)))
        continue
      }
      to_process.push(toEntry(row, null))
    } catch (err) {
      opts.onSkip?.(String((row as { id?: unknown } | null)?.id ?? "unknown"), err)
    }
  }

  // Oldest first: the longest-waiting order is the most urgent.
  to_process.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
  to_ship.sort((a, b) => (a.packed_at ?? "").localeCompare(b.packed_at ?? ""))
  needs_attention.sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "")
  )
  return { to_process, to_ship, needs_attention }
}

// The to_ship entries whose packed_at is older than maxAgeMs. Used by the
// daily alert job ("ingepakt maar nooit verzonden").
export function selectStaleUnshipped(
  queues: VerzendstationQueues,
  nowMs: number,
  maxAgeMs: number
): QueueEntry[] {
  return queues.to_ship.filter((e) => {
    const t = e.packed_at ? new Date(e.packed_at).getTime() : NaN
    return Number.isFinite(t) && nowMs - t >= maxAgeMs
  })
}
