import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { sumOrderWeightGrams, suggestBoxPreset } from "../../../modules/dhl-parcel/box-selector"
import { findDhlParcelMethod } from "./validate-order"
import { itemQuantity } from "../../../lib/item-quantity"
import type { DhlParcelContact } from "../../../modules/dhl-parcel/types"

// Same literal as in validate-order: the dhl-parcel-boxes module registration
// key. Used as a string so this step does not pull the MikroORM model into the
// workflow's import graph.
const DHL_PARCEL_BOXES_MODULE = "dhl_parcel_boxes"

// String literal for the settings module | same pattern as above; avoids
// pulling the MikroORM model into the workflow's import graph.
const DHL_PARCEL_SETTINGS_MODULE = "dhl_parcel_settings"

type BoxPreset = {
  id: string
  name: string
  // Real DHL keys confirmed 2026-06-06: LARGE does not exist; XSMALL and SMALL_MEDIUM do.
  parcel_type_key: "XSMALL" | "SMALL" | "SMALL_MEDIUM" | "MEDIUM"
  max_items: number
  length_cm: number
  width_cm: number
  height_cm: number
}

export type BuildPayloadInput = {
  order: {
    id: string
    display_id: number
    shipping_methods?: Array<{
      data?: Record<string, any> | null
      shipping_option?: { data?: Record<string, any> | null } | null
    }>
    // quantity is `unknown` on purpose: the order comes from a direct
    // query.graph, which serves it as a number, as a raw { value, precision }
    // bigNumber, or as undefined with the real value on `detail`.
    items: Array<{
      id?: string
      quantity?: unknown
      raw_quantity?: unknown
      detail?: { quantity?: unknown; raw_quantity?: unknown } | null
      product?: { weight?: number | null } & Record<string, any>
    }>
  }
}

/**
 * CONTRACT with DhlParcelFulfillmentProviderService.createFulfillment:
 *
 * This step is the single owner of the fulfillment `data` and `items` that the
 * provider depends on. It MUST:
 *   - set `dhl_parcel_type_key` (the DHL parcel type from the chosen box preset)
 *   - set `dhl_box_dimensions` ({ length, width, height } in cm)
 *   - carry `dhl_option` (DOOR/PS) and, for PS, `service_point_id`
 *   - return `items` enriched with `product.weight`, because the provider calls
 *     `sumOrderWeightGrams(items)` and reads `items[i].product.weight`.
 *
 * It MUST NOT generate `dhl_label_id`: the provider derives that deterministically
 * from `order.display_id` (idempotency seed at DHL). See service.ts.
 */
const buildPayload = createStep(
  "build-dhl-parcel-payload",
  async (input: BuildPayloadInput, { container }: any) => {
    const { order } = input
    const items = (order.items ?? []).filter(Boolean)

    // Resolve every quantity ONCE, at the boundary: raw arithmetic on the
    // query.graph shapes yields NaN weight (which the provider then reports as
    // the misleading "an order item is missing a product weight") and a string
    // totalUnits (which silently selects the largest parcel type, so wrong box
    // and wrong price). Fail explicitly instead.
    const quantified = items.map((it) => {
      const quantity = itemQuantity(it)
      if (quantity == null) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Kan het aantal van orderregel "${it.product?.title ?? it.id ?? "?"}" niet bepalen; geen DHL-label mogelijk.`,
        )
      }
      return { ...it, quantity }
    })

    // Total weight in grams + total units (sum of quantities).
    const dhlTotalWeightGrams = sumOrderWeightGrams(
      quantified.map((it) => ({ quantity: it.quantity, product: it.product })),
    )
    const totalUnits = quantified.reduce((sum, it) => sum + it.quantity, 0)

    // Pick the best-fit box preset for the unit count.
    const boxesService = container.resolve(DHL_PARCEL_BOXES_MODULE)
    const presets: BoxPreset[] = await boxesService.listDhlParcelBoxPresets()
    const { preset } = suggestBoxPreset(presets, totalUnits)

    // Resolve the admin-saved warehouse address (settings singleton). Degrades
    // gracefully: if the module is missing or the list is empty we leave
    // dhl_shipper undefined so the service falls back to the env constant.
    let dhl_shipper: DhlParcelContact | undefined
    // Hide the sender on the label by default (DHL "SSN" option). Operator can
    // turn this off in admin Settings > DHL Parcel; only an explicit false shows
    // the sender.
    let dhl_hide_sender = true
    try {
      const settingsService = container.resolve(DHL_PARCEL_SETTINGS_MODULE)
      const rows: any[] = await settingsService.listDhlParcelSettings({})
      const row = rows[0]
      if (row) {
        dhl_hide_sender = row.hide_sender !== false
        dhl_shipper = {
          name: { companyName: row.shipper_name },
          address: {
            countryCode: row.shipper_country_code,
            postalCode: row.shipper_postal_code,
            city: row.shipper_city,
            street: row.shipper_street,
            number: row.shipper_number ?? undefined,
            isBusiness: true,
          },
          email: row.shipper_email || undefined,
          phoneNumber: row.shipper_phone || undefined,
        }
      }
    } catch {
      // Module not registered in this context (e.g. isolated test) | fall back
      // to the env shipper in the service.
    }

    // Use the shared finder so we pick the DHL Parcel method specifically, not
    // just shipping_methods[0] which may be a fee/discount method.
    const method = findDhlParcelMethod(order.shipping_methods ?? [])
    const methodData = { ...(method?.shipping_option?.data ?? {}), ...(method?.data ?? {}) }
    const dhlOption = methodData.dhl_option as "DOOR" | "PS" | undefined
    const servicePointId =
      dhlOption === "PS" ? (methodData.service_point_id as string | undefined) : undefined

    // Enrich items so the provider can recompute weight from product.weight.
    // They carry the RESOLVED numeric quantity, so the provider's fallback
    // recompute cannot hit the raw bigNumber shape either.
    const enrichedItems = quantified.map((it) => ({
      ...it,
      product: { ...(it.product ?? {}), weight: it.product?.weight },
    }))

    return new StepResponse({
      dhl_option: dhlOption,
      service_point_id: servicePointId,
      dhl_parcel_type_key: preset.parcel_type_key,
      dhl_box_dimensions: {
        length: preset.length_cm,
        width: preset.width_cm,
        height: preset.height_cm,
      },
      dhl_total_weight_grams: dhlTotalWeightGrams,
      total_units: totalUnits,
      items: enrichedItems,
      dhl_shipper,
      dhl_hide_sender,
    })
  },
)

export default buildPayload
