// Pure logic for the fulfillment checklist: state shape, action application,
// gates, and step derivation. No I/O, no React | unit-testable and shared by
// the admin widget, the checklist API route, the dhl-label gates and the
// Verzendstation queue. Mirrors the order-payment-broker.logic.ts pattern.

import {
  toAmount,
  type AmountLike,
  type PaymentView,
} from "./order-payment-broker.logic"

export type ChecklistActor = { by_id: string; by_name: string }

export type ChecklistTick = ChecklistActor & { at: string }

export type ChecklistOverrideStep = "items" | "payment"

export type ChecklistOverride = ChecklistTick & {
  step: ChecklistOverrideStep
  reason: string
}

export type ChecklistState = {
  version: 1
  items: Record<string, ChecklistTick>
  package_closed: ChecklistTick | null
  overrides: ChecklistOverride[]
}

export const MIN_OVERRIDE_REASON = 10

export function emptyChecklist(): ChecklistState {
  return { version: 1, items: {}, package_closed: null, overrides: [] }
}

function parseTick(v: unknown): ChecklistTick | null {
  const t = v as Partial<ChecklistTick> | null | undefined
  if (!t || typeof t !== "object" || typeof t.at !== "string") return null
  return { at: t.at, by_id: String(t.by_id ?? ""), by_name: String(t.by_name ?? "") }
}

// Tolerant parse of order.metadata.fulfillment_checklist. Anything malformed
// degrades to the empty state (old orders, hand-edited metadata) instead of
// throwing.
export function parseChecklist(metadata: unknown): ChecklistState {
  const raw = (metadata as Record<string, unknown> | null | undefined)
    ?.fulfillment_checklist as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyChecklist()

  const items: Record<string, ChecklistTick> = {}
  const rawItems = raw.items
  if (rawItems && typeof rawItems === "object" && !Array.isArray(rawItems)) {
    for (const [k, v] of Object.entries(rawItems as Record<string, unknown>)) {
      const tick = parseTick(v)
      if (tick) items[k] = tick
    }
  }

  const overrides: ChecklistOverride[] = Array.isArray(raw.overrides)
    ? (raw.overrides as unknown[]).flatMap((o) => {
        const ov = o as Partial<ChecklistOverride> | null
        if (!ov || (ov.step !== "items" && ov.step !== "payment")) return []
        if (typeof ov.reason !== "string") return []
        return [
          {
            step: ov.step,
            reason: ov.reason,
            at: String(ov.at ?? ""),
            by_id: String(ov.by_id ?? ""),
            by_name: String(ov.by_name ?? ""),
          },
        ]
      })
    : []

  return {
    version: 1,
    items,
    package_closed: parseTick(raw.package_closed),
    overrides,
  }
}

export type ChecklistAction =
  | { action: "tick_item"; item_id: string; checked: boolean }
  | { action: "package_closed"; checked: boolean }
  | { action: "override"; step: ChecklistOverrideStep; reason: string }

// Apply one action. Returns the next state, or a Dutch error for bad input.
export function applyChecklistAction(
  state: ChecklistState,
  action: ChecklistAction,
  actor: ChecklistActor,
  nowIso: string
): { next: ChecklistState } | { error: string } {
  if (action?.action === "tick_item") {
    if (typeof action.item_id !== "string" || !action.item_id) {
      return { error: "item_id ontbreekt." }
    }
    const items = { ...state.items }
    if (action.checked) items[action.item_id] = { at: nowIso, ...actor }
    else delete items[action.item_id]
    return { next: { ...state, items } }
  }
  if (action?.action === "package_closed") {
    return {
      next: {
        ...state,
        package_closed: action.checked ? { at: nowIso, ...actor } : null,
      },
    }
  }
  if (action?.action === "override") {
    const reason = (action.reason ?? "").trim()
    if (action.step !== "items" && action.step !== "payment") {
      return { error: "Ongeldige override-stap." }
    }
    if (reason.length < MIN_OVERRIDE_REASON) {
      return { error: `Geef een reden van minimaal ${MIN_OVERRIDE_REASON} tekens op.` }
    }
    return {
      next: {
        ...state,
        overrides: [...state.overrides, { step: action.step, reason, at: nowIso, ...actor }],
      },
    }
  }
  return { error: "Onbekende actie." }
}

export function allItemsTicked(itemIds: string[], state: ChecklistState): boolean {
  return itemIds.length > 0 && itemIds.every((id) => Boolean(state.items[id]))
}

export function hasOverride(state: ChecklistState, step: ChecklistOverrideStep): boolean {
  return state.overrides.some((o) => o.step === step)
}

export type PaymentGate = { ok: boolean; reason: string | null }

// Server-side gate on the raw Medusa payment record (the broker payment
// resolved via resolveBrokerPayment). Fully captured + zero refunds + not
// canceled, or it blocks with a Dutch reason.
export function evaluatePaymentGate(
  payment:
    | {
        amount?: AmountLike
        captured_amount?: AmountLike
        refunded_amount?: AmountLike
        canceled_at?: string | Date | null
      }
    | null
    | undefined
): PaymentGate {
  if (!payment) {
    return { ok: false, reason: "Geen betaling gevonden voor deze bestelling" }
  }
  if (payment.canceled_at) {
    return { ok: false, reason: "De betaling is geannuleerd" }
  }
  const amount = toAmount(payment.amount)
  const captured = toAmount(payment.captured_amount)
  const refunded = toAmount(payment.refunded_amount)
  if (refunded > 0) {
    return { ok: false, reason: "Er is (deels) terugbetaald op deze bestelling" }
  }
  // Sub-cent tolerance so float representation never blocks a real capture.
  if (captured <= 0 || captured + 0.005 < amount) {
    return { ok: false, reason: "De betaling is nog niet (volledig) ontvangen" }
  }
  return { ok: true, reason: null }
}

// Client-side gate on the PaymentView returned by GET /admin/orders/:id/payment.
export function paymentViewGate(view: PaymentView | null): PaymentGate {
  if (!view) {
    return { ok: false, reason: "Geen betaling gevonden voor deze bestelling" }
  }
  if (view.status === "canceled") {
    return { ok: false, reason: "De betaling is geannuleerd" }
  }
  if (view.refunded_total > 0) {
    return { ok: false, reason: "Er is (deels) terugbetaald op deze bestelling" }
  }
  if (view.captured_total <= 0 || view.captured_total + 0.005 < view.amount) {
    return { ok: false, reason: "De betaling is nog niet (volledig) ontvangen" }
  }
  return { ok: true, reason: null }
}

export type StepId = "payment" | "pick" | "label" | "close" | "ship"
export type StepState = "done" | "active" | "locked" | "blocked"

// Sequential unlock rules. A SHIPMENT still forces every step done: legacy
// orders fulfilled before the checklist existed must never demand
// retroactive ticks. A label alone no longer forces the payment step done,
// because the payment gate re-evaluates live: a refund arriving after the
// package was already labeled must flip step 1 back to "blocked" and
// re-lock steps 4-5 (close, ship) so the order can't be shipped out unpaid.
// The package-closed tick likewise only counts while an active label exists:
// cancelling a label means the box was opened again, so a stale tick from the
// previous attempt must not keep step 4 green.
export function deriveStepStates(input: {
  paymentOk: boolean
  paymentOverridden: boolean
  itemsTicked: boolean
  itemsOverridden: boolean
  hasLabel: boolean
  packageClosed: boolean
  shipped: boolean
}): Record<StepId, StepState> {
  const paymentDone =
    input.paymentOk || input.paymentOverridden || input.shipped
  const pickDone =
    input.itemsTicked || input.itemsOverridden || input.hasLabel || input.shipped
  const labelDone = input.hasLabel || input.shipped
  const closeDone = (input.packageClosed && labelDone) || input.shipped
  const shipDone = input.shipped
  return {
    payment: paymentDone ? "done" : "blocked",
    pick: pickDone ? "done" : paymentDone ? "active" : "locked",
    label: labelDone ? "done" : paymentDone && pickDone ? "active" : "locked",
    close: closeDone ? "done" : labelDone && paymentDone ? "active" : "locked",
    ship: shipDone ? "done" : closeDone && paymentDone ? "active" : "locked",
  }
}
