import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/types"
import {
  Button,
  Checkbox,
  Container,
  Heading,
  Prompt,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { customerNoteFromOrder } from "./customer-note.logic"
import { decodeBase64DataUri } from "./order-dhl-parcel.logic"
import {
  allItemsTicked,
  deriveStepStates,
  hasOverride,
  hasUnpackedNativeFulfillment,
  labelFailureFromResponse,
  MIN_OVERRIDE_REASON,
  parseChecklist,
  paymentViewGate,
  type ChecklistOverrideStep,
  type ChecklistState,
  type StepState,
} from "./order-fulfillment-checklist.logic"
import type { PaymentView } from "./order-payment-broker.logic"

// ─── Types for the extra fields we fetch beyond the shallow AdminOrder ───────

type DhlShippingMethod = {
  id: string
  data?: Record<string, unknown> | null
}

type FulfillmentLabel = {
  tracking_number?: string | null
  tracking_url?: string | null
  label_url?: string | null
}

type DhlFulfillment = {
  id: string
  provider_id: string
  packed_at?: string | null
  shipped_at?: string | null
  canceled_at?: string | null
  data?: Record<string, unknown> | null
  labels?: FulfillmentLabel[]
}

type ChecklistLineItem = {
  id: string
  quantity: number
  title?: string | null
  product_title?: string | null
  variant_title?: string | null
  variant_sku?: string | null
  variant?: {
    product?: { weight?: number | null; title?: string | null } | null
  } | null
}

type TrackingEventView = { at: string; title: string }

type TrackingView = {
  phase: "aangemeld" | "onderweg" | "bezorgd" | "onbekend"
  phase_label: string
  delivered_at: string | null
  last_event_at: string | null
  handed_to_dhl: boolean
  events: TrackingEventView[]
}

type TrackingResponse = {
  tracking: TrackingView | null
  tracking_number: string | null
  tracking_url: string | null
}

type FetchedOrder = {
  id: string
  metadata?: Record<string, unknown> | null
  shipping_methods?: DhlShippingMethod[]
  fulfillments?: DhlFulfillment[]
  items?: ChecklistLineItem[]
}

// NOTE: never request shipping_methods.shipping_option.* here | that
// cross-module expansion 500s the admin order GET (see the old DHL widget's
// history). The DHL method is identified from shipping_methods.data.
const ORDER_FIELDS = [
  "id",
  "metadata",
  "shipping_methods.id",
  "shipping_methods.data",
  "fulfillments.id",
  "fulfillments.provider_id",
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  "fulfillments.data",
  "fulfillments.labels.tracking_number",
  "fulfillments.labels.tracking_url",
  "fulfillments.labels.label_url",
  "items.id",
  "items.quantity",
  "items.title",
  "items.product_title",
  "items.variant_title",
  "items.variant_sku",
  "items.variant.product.weight",
  "items.variant.product.title",
].join(",")

// ─── Order-shape helpers (ported from the old DHL widget) ────────────────────

function findDhlMethod(order: FetchedOrder): DhlShippingMethod | null {
  return (
    (order.shipping_methods ?? []).find(
      (m) => m.data && typeof m.data.dhl_option === "string"
    ) ?? null
  )
}

function findDhlFulfillment(order: FetchedOrder): DhlFulfillment | null {
  return (
    (order.fulfillments ?? []).find((f) => {
      if (f.canceled_at) return false
      if (f.provider_id === "dhl-parcel" || f.provider_id === "dhl-parcel_dhl-parcel") {
        return true
      }
      if (f.data?.dhl_tracking_number) return true
      return (f.labels ?? []).some(
        (l) => l.tracking_number != null && l.tracking_number !== ""
      )
    }) ?? null
  )
}

function getTrackingNumber(f: DhlFulfillment): string | null {
  if (typeof f.data?.dhl_tracking_number === "string") {
    return f.data.dhl_tracking_number as string
  }
  return f.labels?.[0]?.tracking_number ?? null
}

function getLabelPdfUrl(f: DhlFulfillment): string | null {
  if (typeof f.data?.dhl_label_pdf_url === "string") {
    return f.data.dhl_label_pdf_url as string
  }
  return f.labels?.[0]?.label_url ?? null
}

// data: PDFs cannot be opened in a top-level tab directly | decode to a Blob.
function openLabelPdf(url: string) {
  const decoded = decodeBase64DataUri(url)
  if (!decoded) {
    window.open(url, "_blank", "noopener,noreferrer")
    return
  }
  const blob = new Blob([decoded.bytes as BlobPart], { type: decoded.mime })
  const objectUrl = URL.createObjectURL(blob)
  window.open(objectUrl, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

function productsMissingWeight(order: FetchedOrder): string[] {
  const names = new Set<string>()
  for (const item of order.items ?? []) {
    if (item.variant?.product?.weight == null) {
      names.add(
        item.product_title || item.title || item.variant?.product?.title || "Onbekend product"
      )
    }
  }
  return [...names]
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const STEP_TITLES: Record<string, string> = {
  payment: "Betaling gecontroleerd",
  pick: "Items verzamelen",
  label: "DHL-label maken",
  close: "Label geprint, pakket gesloten",
  ship: "Verzenden + klant mailen",
}

function StepBadge({ n, state }: { n: number; state: StepState }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
    border: "1px solid",
  }
  if (state === "done") {
    return (
      <span style={{ ...style, borderColor: "#86efac", background: "#f0fdf4", color: "#166534" }}>
        ✓
      </span>
    )
  }
  if (state === "blocked") {
    return (
      <span style={{ ...style, borderColor: "#fca5a5", background: "#fef2f2", color: "#991b1b" }}>
        !
      </span>
    )
  }
  const dim = state === "locked"
  return (
    <span
      style={{
        ...style,
        borderColor: dim ? "#e5e7eb" : "#111827",
        background: dim ? "#f9fafb" : "#111827",
        color: dim ? "#9ca3af" : "#ffffff",
      }}
    >
      {n}
    </span>
  )
}

function StepRow({
  n,
  id,
  state,
  children,
}: {
  n: number
  id: string
  state: StepState
  children?: ReactNode
}) {
  const locked = state === "locked"
  return (
    <div
      className="flex gap-3 px-6 py-4"
      style={locked ? { opacity: 0.45 } : undefined}
    >
      <StepBadge n={n} state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Text size="small" weight="plus">
          Stap {n}. {STEP_TITLES[id]}
        </Text>
        {children}
      </div>
    </div>
  )
}

// Reason prompt used by both override flows.
function OverridePrompt({
  open,
  onOpenChange,
  title,
  description,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  busy: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  const tooShort = reason.trim().length < MIN_OVERRIDE_REASON

  useEffect(() => {
    if (!open) setReason("")
  }, [open])

  return (
    <Prompt open={open} onOpenChange={onOpenChange}>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>{title}</Prompt.Title>
          <Prompt.Description>{description}</Prompt.Description>
        </Prompt.Header>
        <div className="px-6 pb-4">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Reden (minimaal ${MIN_OVERRIDE_REASON} tekens, komt in het logboek)`}
            rows={3}
          />
        </div>
        <Prompt.Footer>
          <Prompt.Cancel disabled={busy}>Annuleren</Prompt.Cancel>
          <Prompt.Action
            disabled={tooShort || busy}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? "Bezig..." : "Doorgaan zonder controle"}
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  )
}

// ─── Widget ───────────────────────────────────────────────────────────────────

const OrderFulfillmentChecklistWidget = ({
  data,
}: DetailWidgetProps<AdminOrder>) => {
  const orderId = data.id

  const [order, setOrder] = useState<FetchedOrder | null>(null)
  const [paymentView, setPaymentView] = useState<PaymentView | null>(null)
  const [trackingRes, setTrackingRes] = useState<TrackingResponse | null>(null)
  const [checklist, setChecklist] = useState<ChecklistState | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [busyItem, setBusyItem] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [shipOpen, setShipOpen] = useState(false)
  const [overrideStep, setOverrideStep] = useState<ChecklistOverrideStep | null>(null)
  // The last label failure, kept on screen after the toast is gone: a toast is
  // the wrong place for something the operator has to read, act on, or escalate.
  const [labelError, setLabelError] = useState<
    { message: string; details: string | null } | null
  >(null)

  async function loadAll(quiet = false) {
    if (!quiet) setLoading(true)
    setFetchError(null)
    try {
      const [orderRes, paymentRes, trackRes] = await Promise.all([
        fetch(`/admin/orders/${orderId}?fields=${ORDER_FIELDS}`, {
          credentials: "include",
        }),
        fetch(`/admin/orders/${orderId}/payment`, { credentials: "include" }),
        fetch(`/admin/orders/${orderId}/dhl-tracking`, { credentials: "include" }),
      ])
      if (!orderRes.ok) throw new Error(`Laden mislukt (${orderRes.status})`)
      const orderJson = (await orderRes.json()) as { order?: FetchedOrder }
      const fetched = orderJson.order ?? null
      setOrder(fetched)
      setChecklist(parseChecklist(fetched?.metadata))
      // 404 = no broker payment on this order | the gate reports that itself.
      if (paymentRes.ok) {
        const paymentJson = (await paymentRes.json()) as { payment?: PaymentView }
        setPaymentView(paymentJson.payment ?? null)
      } else {
        setPaymentView(null)
      }
      if (trackRes.ok) {
        setTrackingRes((await trackRes.json()) as TrackingResponse)
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Onbekende fout")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
    const timer = setInterval(() => void loadAll(true), 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  async function postChecklist(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/admin/orders/${orderId}/fulfillment-checklist`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as {
        fulfillment_checklist?: ChecklistState
        message?: string
      }
      if (!res.ok) throw new Error(json.message ?? `Opslaan mislukt (${res.status})`)
      if (json.fulfillment_checklist) setChecklist(json.fulfillment_checklist)
      return true
    } catch (err) {
      toast.error("Checklist bijwerken mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
      return false
    }
  }

  async function tickItem(itemId: string, checked: boolean) {
    setBusyItem(itemId)
    await postChecklist({ action: "tick_item", item_id: itemId, checked })
    setBusyItem(null)
  }

  async function setPackageClosed(checked: boolean) {
    setBusyAction(true)
    await postChecklist({ action: "package_closed", checked })
    setBusyAction(false)
  }

  async function confirmOverride(step: ChecklistOverrideStep, reason: string) {
    setBusyAction(true)
    const ok = await postChecklist({ action: "override", step, reason })
    setBusyAction(false)
    if (ok) {
      setOverrideStep(null)
      toast.success("Override vastgelegd in het logboek")
    }
  }

  async function createLabel() {
    setBusyAction(true)
    setLabelError(null)
    try {
      const res = await fetch(`/admin/orders/${orderId}/dhl-label`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const body = (await res.json().catch(() => ({}))) as {
        message?: string
        code?: string
        details?: string | null
        tracking_number?: string
      }
      if (!res.ok) {
        // The route knows WHY this failed (expired DHL key, rejected address,
        // DHL outage, missing product weight, no box presets) and says so in
        // Dutch, with the raw technical message in `details`. Both are kept:
        // the toast disappears, the block under step 3 does not.
        const failure = labelFailureFromResponse(res.status, body)
        setLabelError(failure)
        setCreateOpen(false)
        toast.error("Label aanmaken mislukt", { description: failure.message })
        return
      }
      toast.success(
        `DHL-label aangemaakt${body.tracking_number ? ` | ${body.tracking_number}` : ""}`
      )
      setCreateOpen(false)
      await loadAll()
    } catch (err) {
      // Network-level failure: the request never got an answer.
      const failure = {
        message:
          "De aanvraag kon de server niet bereiken. Controleer de verbinding en probeer het opnieuw; er wordt nooit twee keer een label gekocht.",
        details: err instanceof Error ? err.message : null,
      }
      setLabelError(failure)
      toast.error("Label aanmaken mislukt", { description: failure.message })
    } finally {
      setBusyAction(false)
    }
  }

  async function markShipped(isResend: boolean) {
    setBusyAction(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/dhl-label/send-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // Explicit resend: the backend switches to a unique idempotency key so
        // the customer actually receives a second copy.
        body: JSON.stringify({ resend: isResend }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        message?: string
        sent?: boolean
        reason?: string
      }
      if (!res.ok) throw new Error(body.message ?? `Verzenden mislukt (${res.status})`)
      // Report what really happened. The route used to answer 200 even when the
      // notification module skipped the send.
      if (body.sent === false) {
        toast.warning("Geen e-mail verstuurd", {
          description:
            body.reason === "already_sent"
              ? "De klant heeft deze verzendmail al ontvangen."
              : `De verzendmail is niet verstuurd (${body.reason ?? "onbekende reden"}).`,
        })
      } else {
        toast.success(
          isResend
            ? "Verzendmail opnieuw verstuurd naar klant"
            : "Gemarkeerd als verzonden | klant gemaild"
        )
      }
      setShipOpen(false)
      await loadAll()
    } catch (err) {
      toast.error("Verzendmail verzenden mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
    } finally {
      setBusyAction(false)
    }
  }

  // ── Loading / error ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Verzendchecklist laden...
          </Text>
        </div>
      </Container>
    )
  }
  if (fetchError || !order || !checklist) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            Fout bij laden van de verzendchecklist: {fetchError ?? "geen data"}
          </Text>
        </div>
      </Container>
    )
  }

  // ── Derivations ─────────────────────────────────────────────────────────────

  const items = order.items ?? []
  const itemIds = items.map((i) => i.id)
  const dhlMethod = findDhlMethod(order)
  const dhlFulfillment = findDhlFulfillment(order)
  const trackingNumber = dhlFulfillment ? getTrackingNumber(dhlFulfillment) : null
  const labelPdfUrl = dhlFulfillment ? getLabelPdfUrl(dhlFulfillment) : null
  const hasLabel = Boolean(trackingNumber)
  const shipped = Boolean(dhlFulfillment?.shipped_at)

  const gate = paymentViewGate(paymentView)
  const paymentOverridden = hasOverride(checklist, "payment")
  const itemsOverridden = hasOverride(checklist, "items")
  const itemsTicked = allItemsTicked(itemIds, checklist)
  const missingWeight = productsMissingWeight(order)

  // A canceled label invalidates the package-closed tick: the box was opened
  // again for the redo, so the stored tick from the previous attempt must not
  // show as confirmed (deriveStepStates applies the same rule).
  const packageClosed = Boolean(checklist.package_closed) && (hasLabel || shipped)

  const steps = deriveStepStates({
    paymentOk: gate.ok,
    paymentOverridden,
    itemsTicked,
    itemsOverridden,
    hasLabel,
    packageClosed,
    shipped,
  })

  const methodData = dhlMethod?.data ?? {}
  const isPs = methodData.dhl_option === "PS"
  const allDone = steps.ship === "done"
  const customerNote = customerNoteFromOrder(order)
  // Someone pressed Medusa's native "Fulfill items". That fulfillment has no
  // label and no tracking, and it takes the order out of the Verzendstation
  // work queues, so it has to be said out loud here too.
  const nativeFulfillment = hasUnpackedNativeFulfillment(order.fulfillments)

  return (
    <>
      <Container className="divide-y p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col gap-1">
            <Heading level="h2">Verzendchecklist</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Werk de stappen van boven naar beneden af. Een stap gaat pas open
              als de vorige klaar is.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={() =>
                window.open(`/admin/orders/${orderId}/picklist`, "_blank", "noopener")
              }
            >
              Print picklijst
            </Button>
            {allDone ? (
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
                style={{ border: "1px solid #86efac", background: "#f0fdf4", color: "#166534" }}
              >
                Afgerond
              </span>
            ) : null}
          </div>
        </div>

        {/* Native "Fulfill items" warning. Rendered ONLY when that fulfillment
            really exists, so it never becomes background noise. */}
        {nativeFulfillment ? (
          <div className="px-6 py-4">
            <div
              style={{
                borderLeft: "3px solid #dc2626",
                background: "#fef2f2",
                padding: "10px 14px",
              }}
            >
              <Text
                size="xsmall"
                weight="plus"
                className="uppercase"
                style={{ color: "#991b1b", letterSpacing: "0.06em" }}
              >
                Handmatige fulfillment gevonden
              </Text>
              <Text size="small" style={{ color: "#7f1d1d", marginTop: 4 }}>
                Er is een fulfillment aangemaakt met de Engelse knop &quot;Fulfill
                items&quot; in plaats van met deze checklist. Die fulfillment
                heeft geen DHL-label en geen track-and-trace, en hij houdt de
                bestelling uit het Verzendstation. Annuleer hem hierboven met
                &quot;Cancel fulfillment&quot; en maak het label daarna met de knop
                bij stap 3.
              </Text>
            </div>
          </div>
        ) : null}

        {/* Customer note. Rendered ONLY when the customer left one, so its
            presence is itself the signal that something needs reading. */}
        {customerNote ? (
          <div className="px-6 py-4">
            <div
              style={{
                borderLeft: "3px solid #0d9488",
                background: "#f0fdfa",
                padding: "10px 14px",
              }}
            >
              <Text
                size="xsmall"
                weight="plus"
                className="uppercase"
                style={{ color: "#0f766e", letterSpacing: "0.06em" }}
              >
                Klantopmerking
              </Text>
              <Text
                size="small"
                style={{ color: "#134e4a", whiteSpace: "pre-wrap", marginTop: 4 }}
              >
                {customerNote}
              </Text>
            </div>
          </div>
        ) : null}

        {/* Step 1: payment */}
        <StepRow n={1} id="payment" state={steps.payment}>
          {steps.payment === "done" ? (
            <Text size="small" className="text-ui-fg-subtle">
              {gate.ok
                ? "De betaling is volledig ontvangen en niet terugbetaald."
                : paymentOverridden
                  ? "Betaalcontrole overgeslagen via override (zie logboek onderaan)."
                  : "Reeds afgehandeld."}
            </Text>
          ) : (
            <div
              style={{ border: "1px solid #fca5a5", background: "#fef2f2", padding: "10px 12px" }}
            >
              <Text size="small" weight="plus" style={{ color: "#991b1b" }}>
                {gate.reason ?? "Betaling niet in orde"} | NIET verzenden.
              </Text>
              <Text size="small" style={{ color: "#7f1d1d", marginTop: "2px" }}>
                Controleer de betaling in het blok &quot;Betaling (Mollie via
                broker)&quot; verderop. Alleen de beheerder mag hier met een
                reden omheen.
              </Text>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => setOverrideStep("payment")}
                >
                  Doorgaan zonder controle
                </Button>
              </div>
            </div>
          )}
        </StepRow>

        {/* Step 2: pick items */}
        <StepRow n={2} id="pick" state={steps.pick}>
          <Text size="small" className="text-ui-fg-subtle">
            Pak elk item fysiek en vink het af. Let op de sterkte!
          </Text>
          <div className="flex flex-col gap-1">
            {items.map((item) => {
              const tick = checklist.items[item.id]
              const disabled =
                steps.pick === "locked" || hasLabel || shipped || busyItem === item.id
              return (
                <label
                  key={item.id}
                  className="flex items-center gap-3 border border-ui-border-base px-3 py-2"
                  style={{ cursor: disabled ? "default" : "pointer" }}
                >
                  <Checkbox
                    checked={Boolean(tick)}
                    disabled={disabled}
                    onCheckedChange={(v) => void tickItem(item.id, v === true)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <Text size="small" weight="plus">
                      {item.quantity}x {item.product_title ?? item.title ?? "Onbekend product"}
                      {item.variant_title ? ` | ${item.variant_title}` : ""}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {item.variant_sku ? `SKU ${item.variant_sku}` : ""}
                      {tick ? `${item.variant_sku ? " | " : ""}afgevinkt door ${tick.by_name}` : ""}
                    </Text>
                  </span>
                </label>
              )
            })}
          </div>
          {itemsOverridden && !itemsTicked ? (
            <Text size="xsmall" className="text-ui-fg-subtle">
              Picklijst overgeslagen via override (zie logboek onderaan).
            </Text>
          ) : null}
          {steps.pick === "active" && !itemsTicked ? (
            <div>
              <Button
                variant="transparent"
                size="small"
                onClick={() => setOverrideStep("items")}
              >
                Doorgaan zonder afvinken (met reden)
              </Button>
            </div>
          ) : null}
        </StepRow>

        {/* Step 3: create label */}
        <StepRow n={3} id="label" state={steps.label}>
          {!dhlMethod ? (
            <Text size="small" className="text-ui-fg-subtle">
              Deze bestelling heeft geen DHL-verzendmethode. Maak het label of de
              verzending handmatig aan.
            </Text>
          ) : steps.label === "done" ? (
            <div className="flex flex-col gap-1">
              <Text size="small" className="text-ui-fg-subtle">
                Bezorgwijze: {isPs ? "DHL Servicepunt" : "DHL Thuisbezorgd"}
                {trackingNumber ? ` | tracking ${trackingNumber}` : ""}
              </Text>
              {labelPdfUrl ? (
                <button
                  type="button"
                  onClick={() => openLabelPdf(labelPdfUrl)}
                  className="txt-small text-ui-fg-interactive hover:underline text-left"
                >
                  Download label-PDF
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {missingWeight.length > 0 ? (
                <div
                  style={{ border: "1px solid #fcd34d", background: "#fffbeb", padding: "10px 12px" }}
                >
                  <Text size="small" weight="plus" style={{ color: "#92400e" }}>
                    Product zonder gewicht: {missingWeight.map((n) => `"${n}"`).join(", ")}
                  </Text>
                  <Text size="small" style={{ color: "#78350f", marginTop: "2px" }}>
                    Zonder gewicht kan DHL geen label maken. Stel eerst het
                    gewicht (in gram) in op het product.
                  </Text>
                </div>
              ) : null}
              {labelError ? (
                <div
                  style={{ border: "1px solid #fca5a5", background: "#fef2f2", padding: "10px 12px" }}
                >
                  <Text size="small" weight="plus" style={{ color: "#991b1b" }}>
                    Label aanmaken mislukt
                  </Text>
                  <Text size="small" style={{ color: "#7f1d1d", marginTop: "2px" }}>
                    {labelError.message}
                  </Text>
                  {labelError.details ? (
                    // Disclosure, not a wall of text: the operator escalates
                    // with the real error instead of a screenshot of a generic one.
                    <details style={{ marginTop: "6px" }}>
                      <summary
                        className="txt-small"
                        style={{ color: "#7f1d1d", cursor: "pointer" }}
                      >
                        Technische details
                      </summary>
                      <Text
                        size="xsmall"
                        style={{ color: "#7f1d1d", marginTop: "4px", wordBreak: "break-word" }}
                      >
                        {labelError.details}
                      </Text>
                    </details>
                  ) : null}
                </div>
              ) : null}
              <div>
                <Button
                  variant="primary"
                  size="small"
                  disabled={steps.label !== "active" || missingWeight.length > 0 || busyAction}
                  onClick={() => setCreateOpen(true)}
                >
                  {labelError ? "Probeer opnieuw" : "Maak DHL-label"}
                </Button>
              </div>
            </div>
          )}
        </StepRow>

        {/* Step 4: printed + closed */}
        <StepRow n={4} id="close" state={steps.close}>
          <label className="flex items-center gap-3" style={{ cursor: "pointer" }}>
            <Checkbox
              checked={packageClosed || shipped}
              disabled={steps.close === "locked" || shipped || busyAction}
              onCheckedChange={(v) => void setPackageClosed(v === true)}
            />
            <Text size="small">
              Het label is geprint, zit op het pakket en het pakket is dicht.
              {packageClosed && checklist.package_closed
                ? ` | bevestigd door ${checklist.package_closed.by_name}`
                : ""}
            </Text>
          </label>
        </StepRow>

        {/* Step 5: ship + mail */}
        <StepRow n={5} id="ship" state={steps.ship}>
          {steps.ship === "done" ? (
            <div className="flex items-center justify-between gap-3">
              <Text size="small" className="text-ui-fg-subtle">
                Verzonden | de klant heeft de track-and-trace mail ontvangen.
              </Text>
              <Button variant="secondary" size="small" onClick={() => setShipOpen(true)}>
                Verzendmail opnieuw sturen
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Text size="small" className="text-ui-fg-subtle">
                Geef het pakket af bij DHL. Zodra DHL het pakket scant wordt
                deze stap automatisch afgerond en krijgt de klant de
                track-and-trace mail (controle elke 30 minuten). Handmatig
                markeren kan ook:
              </Text>
              <div>
                <Button
                  variant="primary"
                  size="small"
                  disabled={steps.ship !== "active" || busyAction}
                  onClick={() => setShipOpen(true)}
                >
                  Markeer als verzonden &amp; mail klant
                </Button>
              </div>
              <Text size="xsmall" className="text-ui-fg-muted">
                De Engelse knoppen elders op deze pagina heb je niet nodig:
                &quot;Mark as shipped&quot; doet hetzelfde als deze knop (klant
                krijgt dezelfde mail, nooit dubbel), &quot;Mark as
                delivered&quot; registreert alleen een bezorgdatum en is
                optioneel. Gebruik &quot;Fulfill items&quot; NIET: die knop maakt
                een fulfillment zonder DHL-label en haalt de bestelling uit het
                Verzendstation.
              </Text>
            </div>
          )}
        </StepRow>

        {/* Live shipment status from DHL (feature: live tracking) */}
        {hasLabel ? (
          <div className="px-6 py-4">
            <div className="flex items-center gap-2">
              <Text size="small" weight="plus">
                Zending
              </Text>
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
                style={
                  trackingRes?.tracking?.phase === "bezorgd"
                    ? { border: "1px solid #86efac", background: "#f0fdf4", color: "#166534" }
                    : trackingRes?.tracking?.phase === "onderweg"
                      ? { border: "1px solid #7dd3fc", background: "#f0f9ff", color: "#075985" }
                      : { border: "1px solid #e5e7eb", background: "#f9fafb", color: "#6b7280" }
                }
              >
                {trackingRes?.tracking?.phase_label ?? "Nog geen scans"}
              </span>
              <Text size="xsmall" className="text-ui-fg-muted" style={{ marginLeft: "auto" }}>
                live van DHL, ververst elke minuut
              </Text>
            </div>
            {trackingRes?.tracking && trackingRes.tracking.events.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {trackingRes.tracking.events.slice(0, 4).map((e, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3">
                    <Text size="xsmall" weight={i === 0 ? "plus" : undefined}>
                      {e.title}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-subtle whitespace-nowrap">
                      {new Date(e.at).toLocaleString("nl-NL", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Text>
                  </div>
                ))}
              </div>
            ) : (
              <Text size="xsmall" className="text-ui-fg-muted">
                DHL heeft het pakket nog niet gescand. De status verschijnt hier
                zodra het pakket is afgegeven.
              </Text>
            )}
            {trackingRes?.tracking_url ? (
              <a
                href={trackingRes.tracking_url}
                target="_blank"
                rel="noopener noreferrer"
                className="txt-small text-ui-fg-interactive hover:underline"
              >
                Bekijk bij DHL
              </a>
            ) : null}
          </div>
        ) : null}

        {/* Audit log (only when there is something to show) */}
        {checklist.overrides.length > 0 ? (
          <div className="px-6 py-3">
            <Text size="xsmall" className="text-ui-fg-subtle" weight="plus">
              Logboek overrides
            </Text>
            {checklist.overrides.map((o, i) => (
              <Text key={i} size="xsmall" className="text-ui-fg-subtle">
                {o.step === "payment" ? "Betaalcontrole" : "Picklijst"} overgeslagen
                door {o.by_name} | reden: {o.reason}
              </Text>
            ))}
          </div>
        ) : null}
      </Container>

      {/* Prompts */}
      <Prompt open={createOpen} onOpenChange={setCreateOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>DHL-label aanmaken</Prompt.Title>
            <Prompt.Description>
              Hiermee maak je het DHL-verzendlabel aan voor deze bestelling. De
              verzendkosten worden op je DHL-account in rekening gebracht.
              Controleer eerst het bezorgadres en de bezorgwijze. Doorgaan?
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel disabled={busyAction}>Annuleren</Prompt.Cancel>
            <Prompt.Action onClick={() => void createLabel()}>
              {busyAction ? "Aanmaken..." : "Doorgaan"}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      <Prompt open={shipOpen} onOpenChange={setShipOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>
              {shipped ? "Verzendmail opnieuw sturen" : "Markeer als verzonden"}
            </Prompt.Title>
            <Prompt.Description>
              {shipped
                ? "Deze bestelling is al gemarkeerd als verzonden. Dit stuurt de klant nogmaals dezelfde verzendmail met de track-and-trace link. Doe dit alleen als de klant de mail niet ontvangen heeft. Doorgaan?"
                : "Hiermee wordt de bestelling gemarkeerd als verzonden en ontvangt de klant eenmalig de verzendmail met de track-and-trace link. Doorgaan?"}
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel disabled={busyAction}>Annuleren</Prompt.Cancel>
            <Prompt.Action onClick={() => void markShipped(shipped)}>
              {busyAction ? "Bezig..." : shipped ? "Opnieuw sturen" : "Markeer als verzonden"}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      <OverridePrompt
        key={overrideStep ?? "closed"}
        open={overrideStep !== null}
        onOpenChange={(open) => !open && setOverrideStep(null)}
        title={
          overrideStep === "payment"
            ? "Betaalcontrole overslaan"
            : "Picklijst overslaan"
        }
        description={
          overrideStep === "payment"
            ? "Alleen doen als je ZEKER weet dat er betaald is (bijvoorbeeld handmatige bankoverschrijving). De reden wordt vastgelegd in het logboek."
            : "Alleen doen als afvinken echt niet kan. De reden wordt vastgelegd in het logboek."
        }
        busy={busyAction}
        onConfirm={(reason) => overrideStep && void confirmOverride(overrideStep, reason)}
      />
    </>
  )
}

export const config = defineWidgetConfig({
  // Bottom of the order page (operator preference); was order.details.before.
  zone: "order.details.after",
})

export default OrderFulfillmentChecklistWidget
