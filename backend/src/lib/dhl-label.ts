import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { createDhlParcelShipmentWorkflow } from "../workflows/create-dhl-parcel-shipment"
import { resolveBrokerPayment } from "../api/admin/orders/[id]/payment/resolve"
import {
  allItemsTicked,
  hasOverride,
  parseChecklist,
} from "../admin/widgets/order-fulfillment-checklist.logic"
import { applyChecklistUpdate } from "./fulfillment-checklist-write"
import { TELEGRAM_OPS_MODULE } from "../modules/telegram-ops"
import type TelegramOpsService from "../modules/telegram-ops/service"
import { headline, line } from "../modules/telegram-ops/format"

// All DHL label-creation logic lives here, shared by the admin route
// (POST /admin/orders/:id/dhl-label) and the Telegram bot's Create-label
// action. Callers map the result union to HTTP or bot messages.
//
// Fields loaded via query.graph to give the workflow everything it reads.
//
// query.graph SYNTAX (both verified against prod order #13 on 2026-06-10):
//  1. Use TRAILING-star nested paths ("items.variant.product.*"), NOT the
//     leading-star dotted form ("*items.variant.product"). The leading-star
//     form is what the admin HTTP ?fields= parser / query-config defaults
//     accept, but a direct query.graph call rejects a leading star on a dotted
//     path with "Entity 'Order' does not have property '*items'".
//  2. Do NOT request shipping_methods.shipping_option(.*): that
//     order_shipping_method -> fulfillment shipping_option cross-module
//     expansion is unresolvable here and throws "Cannot read properties of
//     undefined (reading 'strategy')". Both errors 500 the label request BEFORE
//     the try/catch below; (2) was the original order #13 failure and (1) was
//     hiding behind it. The order widget hit the same walls, see
//     order-fulfillment-checklist.tsx.
//
// - items.variant.product.*: the product-weight path. After loading, each item
//   is reshaped so item.product = item.variant?.product, matching the shape the
//   workflow's validate-order / build-payload / service steps expect at
//   item.product.weight.
// - shipping_methods.data: carries the DHL DOOR/PS selection (dhl_option) and,
//   for Servicepunt, the service_point_id. findDhlParcelMethod detects the DHL
//   method from this (provider_id is not needed).
const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "metadata",
  "email",
  "shipping_address.*",
  "items.*",
  "items.variant.*",
  "items.variant.product.*",
  "shipping_methods.id",
  "shipping_methods.data",
  "shipping_methods.shipping_option_id",
  // Existing fulfillments: used to refuse buying a second label for an order
  // that already has one (idempotency guard below).
  "fulfillments.id",
  "fulfillments.provider_id",
  "fulfillments.canceled_at",
  "fulfillments.data",
  "fulfillments.labels.tracking_number",
  "fulfillments.labels.tracking_url",
  "fulfillments.labels.label_url",
]

export type CreateLabelSuccess = {
  fulfillment_id: string
  display_id: number
  tracking_number: string | null
  label_pdf_url: string | null
  shipment_tracking_url: string | null
}

export type CreateLabelResult =
  | ({ status: "created" } & CreateLabelSuccess)
  | ({ status: "exists" } & CreateLabelSuccess)
  | { status: "not_found" }
  | { status: "checklist_blocked"; order_id: string; display_id: number; ticked: number; total: number }
  | { status: "invalid"; httpStatus: number; message: string; details: string }
  | { status: "error"; message: string }

export type ItemsOverride = { byId: string; byName: string; reason: string }

// "DHL Parcel POST /labels failed with 400" on its own is not actionable; the
// body carries the reason. Uses a duck-typed check rather than instanceof so a
// DhlParcelApiError that crossed the workflow-engine serialization boundary is
// still recognised.
function describeError(err: unknown): string {
  const e = err as { message?: string; body?: { key?: string; message?: string } | null }
  const base = e?.message ?? String(err)
  const key = e?.body?.key
  if (!key) return base
  return `${base} (${key}${e.body?.message ? `: ${e.body.message}` : ""})`
}

// N5 push ("Label ready") with the Mark-shipped/Details buttons. Advisory
// only: never throws into the caller (the .catch is load-bearing on Node 22).
function notifyLabelReady(
  container: MedusaContainer,
  fulfillmentId: string,
  displayId: number,
  orderId: string,
  trackingNumber: string | null
): void {
  try {
    const tg = container.resolve(TELEGRAM_OPS_MODULE) as TelegramOpsService
    void tg.notify(
      `tg-label-${fulfillmentId}`,
      "label_created",
      [
        headline("📦", `Label ready #${displayId}`),
        ...(trackingNumber ? [line("Tracking", trackingNumber)] : []),
      ].join("\n"),
      {
        reply_markup: { inline_keyboard: [[
          { text: "🚚 Mark shipped", callback_data: `shp:${orderId}:${displayId}` },
          { text: "Details", callback_data: `det:${displayId}` },
        ]] },
      }
    ).catch(() => {})
  } catch {
    /* advisory only */
  }
}

export async function createDhlLabelForOrder(
  container: MedusaContainer,
  orderId: string,
  opts: { itemsOverride?: ItemsOverride } = {}
): Promise<CreateLabelResult> {
  const logger = container.resolve("logger") as Logger
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // 1. Load the order fully.
  const { data: orders } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: ORDER_FIELDS,
  })

  const raw = orders?.[0]
  if (!raw) return { status: "not_found" }

  // 1b. Idempotency guard: if this order already has a (non-canceled) DHL
  //     fulfillment with a tracking number, return it instead of buying a
  //     second label. The widget hides the create button once a label exists,
  //     but this is the server-side backstop against a double POST (or a
  //     double button tap).
  const existing = ((raw.fulfillments ?? []) as any[]).find((f) => {
    if (f.canceled_at) return false
    const trackingFromLabel = (f.labels ?? []).some(
      (l: any) => l.tracking_number != null && l.tracking_number !== ""
    )
    const trackingFromData = typeof f.data?.dhl_tracking_number === "string"
    const isDhl = f.provider_id === "dhl-parcel_dhl-parcel" || trackingFromData
    return isDhl && (trackingFromData || trackingFromLabel)
  })
  if (existing) {
    const d: any = existing.data ?? {}
    const l: any = existing.labels?.[0] ?? {}
    const tracking_number: string | null = d.dhl_tracking_number ?? l.tracking_number ?? null
    notifyLabelReady(container, existing.id, raw.display_id, orderId, tracking_number)
    logger.info(
      `admin.dhl-label: order ${orderId} already has fulfillment ${existing.id}; returning existing label (no second label bought)`
    )
    return {
      status: "exists",
      fulfillment_id: existing.id,
      display_id: raw.display_id,
      tracking_number,
      label_pdf_url: d.dhl_label_pdf_url ?? l.label_url ?? null,
      shipment_tracking_url: d.dhl_shipment_tracking_url ?? l.tracking_url ?? null,
    }
  }

  // 1c. Label attempt number = how many DHL fulfillments this order already had
  //     (including canceled ones) + 1. The provider seeds the DHL labelId from
  //     order.id + this number, so canceling a wrong label and creating a new
  //     one yields a FRESH DHL label instead of colliding with the old one (DHL
  //     permanently reserves a used label id, so without this the recovery would
  //     just hand back the old, wrong label).
  const priorDhlFulfillments = ((raw.fulfillments ?? []) as any[]).filter(
    (f: any) =>
      f.provider_id === "dhl-parcel_dhl-parcel" ||
      typeof f.data?.dhl_tracking_number === "string"
  ).length
  const labelAttempt = priorDhlFulfillments + 1

  // 1d. Fulfillment-checklist gates. The checklist widget disables the button
  //     client-side; this is the server-side backstop so the flow stays
  //     foolproof even via direct API calls. An explicit, reasoned override
  //     recorded in the checklist (metadata) unlocks each gate separately.
  //     A caller-supplied itemsOverride (the Telegram bot's confirmed
  //     "override + create" tap) is applied as a REAL checklist override
  //     first: same audit trail as the admin widget's override.
  let checklist = parseChecklist((raw as any).metadata)

  // 1d-0. A redo (labelAttempt > 1) means the previous label was canceled and
  //       the box was opened again, so a package_closed tick from that attempt
  //       is stale: step 4 would show green ("bevestigd door X") for a package
  //       that no longer exists. Clear it so the operator has to re-confirm the
  //       NEW label is printed, stuck on and the box closed. Item ticks survive
  //       a redo on purpose (the goods were really picked).
  if (labelAttempt > 1 && checklist.package_closed) {
    const cleared = await applyChecklistUpdate(
      container,
      orderId,
      { action: "package_closed", checked: false },
      { by_id: "system", by_name: "Systeem (label opnieuw aangemaakt)" }
    )
    if (!("error" in cleared)) {
      checklist = cleared.next
      logger.info(
        `admin.dhl-label: cleared stale package_closed for order ${orderId} (label attempt ${labelAttempt})`
      )
    }
  }

  const itemIds = ((raw.items ?? []) as any[]).map((i: any) => String(i.id))
  if (!allItemsTicked(itemIds, checklist) && !hasOverride(checklist, "items")) {
    if (opts.itemsOverride) {
      // Through the shared per-order write queue so an override can never
      // drop a concurrent admin tick (lib/fulfillment-checklist-write.ts).
      const applied = await applyChecklistUpdate(
        container,
        orderId,
        { action: "override", step: "items", reason: opts.itemsOverride.reason },
        { by_id: opts.itemsOverride.byId, by_name: opts.itemsOverride.byName }
      )
      if ("error" in applied) return { status: "error", message: applied.error }
      checklist = applied.next
      logger.info(
        `admin.dhl-label: items override recorded via Telegram for order ${orderId} by ${opts.itemsOverride.byName}`
      )
    } else {
      const ticked = itemIds.filter((id) => Boolean(checklist.items[id])).length
      return {
        status: "checklist_blocked",
        order_id: orderId,
        display_id: raw.display_id,
        ticked,
        total: itemIds.length,
      }
    }
  }

  // The broker payment feeds the payment gate inside the workflow's
  // validate-order step (fully captured, no refunds, not canceled).
  const payment = await resolveBrokerPayment(query, orderId)

  // 2. Reshape items: expose item.product = item.variant?.product so the
  //    workflow (validate-order / build-payload / service) reads
  //    item.product.weight as expected. The natural Medusa v2 graph path is
  //    items[i].variant.product but the workflow contract is items[i].product.
  const reshapedItems = ((raw.items ?? []) as any[]).map((item: any) => ({
    ...item,
    product: item.variant?.product ?? item.product ?? null,
  }))

  const order = {
    ...raw,
    items: reshapedItems,
  }

  // 3. Run the workflow.
  try {
    const { result } = await createDhlParcelShipmentWorkflow(container).run({
      input: {
        order,
        labelAttempt,
        payment,
        paymentOverridden: hasOverride(checklist, "payment"),
      },
    })

    // 4. Map the response. Prefer fulfillment.data.* fields (written by
    //    DhlParcelFulfillmentProviderService.createFulfillment). Fall back to
    //    fulfillment.labels[0] in case data is not fully populated on the
    //    returned object.
    const fulfillment: any = result.fulfillment
    const data: any = fulfillment?.data ?? {}
    const label0: any = fulfillment?.labels?.[0] ?? {}

    const tracking_number: string | null =
      data.dhl_tracking_number ?? label0.tracking_number ?? null

    logger.info(
      `admin.dhl-label: created fulfillment ${result.fulfillment_id} for order ${orderId} | tracking=${tracking_number}`
    )

    notifyLabelReady(container, result.fulfillment_id, raw.display_id, orderId, tracking_number)

    return {
      status: "created",
      fulfillment_id: result.fulfillment_id,
      display_id: raw.display_id,
      tracking_number,
      label_pdf_url: data.dhl_label_pdf_url ?? label0.label_url ?? null,
      shipment_tracking_url: data.dhl_shipment_tracking_url ?? label0.tracking_url ?? null,
    }
  } catch (err: any) {
    // Distinguish workflow validation failures (MedusaError) from unexpected errors.
    // NOTE: use isMedusaError (not instanceof): the workflow engine serializes step
    // errors to plain objects before re-throwing, so instanceof fails but the
    // __isMedusaError marker (checked by isMedusaError) survives.
    if (MedusaError.isMedusaError(err)) {
      const httpStatus =
        err.type === MedusaError.Types.NOT_FOUND ? 404
        : err.type === MedusaError.Types.NOT_ALLOWED ? 400
        : err.type === MedusaError.Types.INVALID_DATA ? 400
        : 500

      logger.warn(
        `admin.dhl-label: workflow validation failed for order ${orderId}: [${err.type}] ${err.message}`
      )
      return { status: "invalid", httpStatus, message: err.message, details: err.type }
    }

    // DHL answers a rejected label with a JSON body that names the reason
    // ({"key":"capabilities_retrieve_empty",...}). Without it the log says only
    // "failed with 400" and the next incident needs a live reproduction to
    // diagnose | so append it for the log AND for the operator.
    const message = describeError(err)
    logger.error(`admin.dhl-label: unexpected error for order ${orderId}: ${message}`)
    return { status: "error", message }
  }
}
