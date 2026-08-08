import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import {
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { v5 as uuidv5 } from "uuid"

import {
  DHL_PARCEL_API_BASE_URL,
  DHL_PARCEL_KEY,
  DHL_PARCEL_SHIPPER,
  DHL_PARCEL_USER_ID,
} from "lib/constants"
import { sumOrderWeightGrams } from "./box-selector"
import { selectDhlOptions } from "./capabilities"
import { DhlParcelClient } from "./client"
import { TokenCache } from "./token-cache"
import { buildDhlConsumerTrackingUrl } from "../../lib/dhl-tracking"
import {
  DhlParcelApiError,
  DhlParcelContact,
  DhlParcelCreateLabelInput,
  DhlParcelLabelResponse,
  DhlParcelOption,
  DhlParcelParcelType,
} from "./types"

// Fixed UUIDv5 namespace used as the idempotency seed for label ids. NEVER
// change this: it is what makes retries dedupe at DHL (a given order always
// derives the same labelId).
const DHL_LABEL_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341"

// DHL's per-lane capability matrix changes on the scale of product launches,
// not minutes, so one lookup per lane per process is plenty.
const CAPABILITIES_TTL_MS = 6 * 60 * 60 * 1000

type InjectedDependencies = { logger: Logger }

// The shipping address may be partial/absent on the fulfillment order; every
// field is optional so each access is guarded below.
type ShippingAddress = Partial<NonNullable<FulfillmentOrderDTO["shipping_address"]>>

class DhlParcelFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "dhl-parcel"

  protected client: DhlParcelClient
  protected logger_: Logger
  private capabilities_ = new Map<string, { at: number; value: unknown }>()

  constructor(container: InjectedDependencies, __: Record<string, unknown>) {
    super()
    this.logger_ = container.logger
    this.client = new DhlParcelClient(
      DHL_PARCEL_API_BASE_URL,
      new TokenCache(DHL_PARCEL_API_BASE_URL, DHL_PARCEL_USER_ID, DHL_PARCEL_KEY),
    )
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    // NOTE: in Medusa v2 this is called WITHOUT a cart/destination, so it cannot
    // filter per-order by country. NL-only is enforced by only seeding these
    // options in the NL region (see the seed task).
    // TODO(EU expansion): when shipping beyond NL, gate options per destination
    // using the DHL capabilities endpoint
    // (GET /capabilities/business?fromCountry=NL&toCountry=<dest>). That check
    // belongs in the checkout/servicepoint flow, not here.
    return [
      { id: "dhl-thuisbezorgd", name: "DHL Thuisbezorgd", data: { dhl_option: "DOOR" } },
      { id: "dhl-servicepunt", name: "DHL Servicepunt", data: { dhl_option: "PS" } },
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    // Medusa passes the shipping option's `data` field here (i.e. what is stored
    // in the `data` column of the shipping_option table), NOT the full option
    // object. Our getFulfillmentOptions() stores `{ dhl_option: "DOOR"|"PS" }`
    // there, so we check dhl_option. Verified against:
    //   node_modules/.pnpm/@medusajs+fulfillment@2.12.1.../fulfillment-provider.js:71
    //   node_modules/.pnpm/@medusajs+utils@2.12.1.../fulfillment/provider.d.ts:160
    return data.dhl_option === "DOOR" || data.dhl_option === "PS"
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext,
  ): Promise<Record<string, unknown>> {
    if (optionData.dhl_option === "PS") {
      const servicePointId = data.service_point_id
      if (typeof servicePointId !== "string" || servicePointId.trim().length === 0) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Selecteer een DHL Servicepunt voordat je verder gaat.",
        )
      }
    }
    return { ...optionData, ...data }
  }

  async canCalculate(): Promise<boolean> {
    return false
  }

  async createFulfillment(
    data: Record<string, any>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    _fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>,
  ): Promise<CreateFulfillmentResult> {
    // 1. Idempotency: a label was already bought for this shipping method.
    if (data.dhl_tracking_number) {
      return {
        data: { ...data },
        labels: [
          {
            tracking_number: data.dhl_tracking_number,
            tracking_url: data.dhl_shipment_tracking_url ?? "",
            label_url: data.dhl_label_pdf_url ?? "",
          },
        ],
      }
    }

    const ord = order ?? {}
    const shippingAddress: ShippingAddress = ord.shipping_address ?? {}

    // 2. Deterministic labelId (idempotency seed at DHL). Seeded from the
    //    globally-unique order id, NOT display_id. DHL permanently reserves a
    //    used "request id" (labelId); display_id is a small sequential int, so a
    //    label created under one key/environment burns that id for another
    //    (observed live as 409 "tracker_code_conflict": request id already used
    //    by a different request). order.id is unique + stable, so each order
    //    still derives ONE fixed labelId (idempotent retries) with no
    //    cross-environment collision. REFERENCE below stays display_id (the
    //    human-readable order number printed on the label).
    const labelAttempt = (ord as { label_attempt?: number }).label_attempt ?? 1
    const labelId: string =
      data.dhl_label_id ?? uuidv5(`${ord.id}-${labelAttempt}`, DHL_LABEL_NAMESPACE)

    // 3. Parcel type. The build-payload step sets this from the chosen box
    //    preset. It is absent when an operator uses Medusa's native "Create
    //    Fulfillment" button instead of the DHL label flow, so fail early with
    //    a clear instruction (checked BEFORE weight so that path doesn't surface
    //    the confusing weight error first).
    const parcelTypeKey = data.dhl_parcel_type_key as DhlParcelParcelType | undefined
    if (!parcelTypeKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Maak het DHL-label via de knop "Maak DHL-label" op de bestelling (niet via de standaard Fulfill-knop): de doos- en gewichtsberekening moet eerst draaien.',
      )
    }

    // 4. Total weight in grams. Prefer the value build-payload already computed
    //    from product weights (carried on `data`); Medusa's fulfillment `items`
    //    do NOT carry product.weight, so recomputing from them would wrongly
    //    fail. Fall back to recomputation only when the pre-computed value is
    //    absent (e.g. a direct provider call outside the workflow).
    const precomputedWeight = data.dhl_total_weight_grams
    const weight =
      typeof precomputedWeight === "number" && precomputedWeight > 0
        ? precomputedWeight
        : sumOrderWeightGrams(
            items as Array<{ quantity: number; product?: { weight?: number | null } }>,
          )

    // 5. Dimensions.
    const dimensions = data.dhl_box_dimensions as
      | { length: number; width: number; height: number }
      | undefined

    // 6. Receiver, mapped from the shipping address.
    const receiver = this.mapReceiver(shippingAddress, ord.email)

    // 7. Shipper: use the admin-saved warehouse address when the build-payload
    //    step resolved it; fall back to the env constant otherwise.
    const shipper = (data.dhl_shipper as DhlParcelContact) ?? this.mapShipper()

    // 8. Account id.
    const accountId = (await this.client.getAccountNumbers())[0]

    // 9. Delivery + reference + signature options.
    //    HANDT (signature on delivery) is confirmed by live /capabilities call
    //    (2026-06-06, sandbox) and is MUTUALLY EXCLUSIVE with PS: the capabilities
    //    response lists PS in HANDT's exclusions array. Therefore HANDT is added
    //    only for DOOR shipments.
    //    The wanted extras are then intersected with what DHL actually offers on
    //    THIS lane (see resolveOptions / capabilities.ts): HANDT and SSN exist
    //    NL->NL and NL->BE but not on DHL PARCEL CONNECT / EUROPLUS, and sending
    //    one anyway fails the whole label with 400 capabilities_retrieve_empty.
    const delivery: DhlParcelOption =
      data.dhl_option === "PS"
        ? { key: "PS", input: data.service_point_id }
        : { key: "DOOR" }
    const wanted: DhlParcelOption[] = [
      { key: "REFERENCE", input: String(ord.display_id) },
      ...(data.dhl_option !== "PS" ? [{ key: "HANDT" } as DhlParcelOption] : []),
      // SSN = undisclosed sender: hides the sender on the label so the recipient
      // can't see who shipped it. Verified accepted standalone + with HANDT for
      // NL->NL B2C. Defaults on; toggled via dhl_parcel_settings.hide_sender.
      ...(data.dhl_hide_sender ? [{ key: "SSN" } as DhlParcelOption] : []),
    ]
    const options = await this.resolveOptions({
      fromCountry: shipper?.address?.countryCode,
      toCountry: receiver.address?.countryCode,
      parcelTypeKey,
      delivery,
      wanted,
    })

    // 10. Pieces.
    const pieces = [{ weight, dimensions }]

    // 11. Buy the label.
    const input: DhlParcelCreateLabelInput = {
      labelId,
      parcelTypeKey,
      receiver,
      shipper,
      accountId,
      options,
      pieces,
    }
    let response: DhlParcelLabelResponse
    try {
      response = await this.client.createLabel(input)
    } catch (err) {
      // Idempotent recovery. The labelId is derived deterministically from the
      // order (step 2), so DHL replies 409 shipment_already_exists when a label
      // was already bought for this order: the operator clicked "Maak DHL-label"
      // twice, or is retrying after the DHL label succeeded but the Medusa
      // fulfillment was rolled back (the module deletes the fulfillment on a
      // provider error). Re-fetch and return the existing label instead of
      // failing | the operator gets the same label, the order is not stranded,
      // and DHL is not charged twice.
      // DHL returns 409 with more than one body key when the labelId is already
      // taken: "shipment_already_exists" (identical re-submit) and
      // "tracker_code_conflict" ("request id already used by a different
      // request", observed with the live key). Recover on ANY 409 by fetching
      // the existing label rather than string-matching one specific key.
      if (err instanceof DhlParcelApiError && err.status === 409) {
        const key = (err.body as { key?: string } | null)?.key
        this.logger_.info(
          `[dhl-parcel] label ${labelId} already exists at DHL (409 ${key ?? "?"}); returning the existing label (idempotent)`,
        )
        response = await this.client.getLabel(labelId)
      } else {
        throw err
      }
    }

    // 12. Tracking number.
    const trackingNumber = response.trackerCode

    // 13. Tracking URL: the my.dhlecommerce.nl consumer deep link (the old
    //     www.dhlecommerce.nl ?key= pattern 404s since DHL's 2026 site
    //     restructure; see buildDhlConsumerTrackingUrl).
    const trackingUrl = buildDhlConsumerTrackingUrl(
      trackingNumber,
      shippingAddress.postal_code
    )

    // 14. Label PDF as a data URI (R2 upload is a documented follow-up).
    const pdfBase64 = response.pdf ?? (await this.client.getLabelPdf(labelId))
    const labelUrl = `data:application/pdf;base64,${pdfBase64}`

    // 15. Result; `data` is persisted on the fulfillment, `labels` creates
    //     FulfillmentLabel rows.
    return {
      data: {
        ...data,
        dhl_label_id: labelId,
        dhl_tracking_number: trackingNumber,
        dhl_label_pdf_url: labelUrl,
        dhl_shipment_tracking_url: trackingUrl,
      },
      labels: [
        {
          tracking_number: trackingNumber,
          tracking_url: trackingUrl,
          label_url: labelUrl,
        },
      ],
    }
  }

  async cancelFulfillment(data: Record<string, any>): Promise<Record<string, unknown>> {
    const labelId = data.dhl_label_id
    if (labelId) {
      try {
        const result = await this.client.tryCancelLabel(labelId)
        if (!result.cancelled) {
          // Cancellation unsupported / already gone | non-fatal, log only.
          this.logCancelUnsupported(labelId)
        }
      } catch (e) {
        // A failed cancel must not block the local cancellation flow.
        this.logCancelUnsupported(labelId, e)
      }
    }
    return {}
  }

  private logCancelUnsupported(labelId: string, error?: unknown): void {
    this.logger_.warn(
      `[dhl-parcel] could not cancel label ${labelId} at DHL (non-fatal)` +
      (error ? ` | ${String(error)}` : ""),
    )
  }

  /**
   * Intersect the options we want with the ones DHL offers for this lane.
   *
   * DHL matches a label request against its capability matrix as a whole: one
   * option the lane does not carry makes the ENTIRE request fail with
   * `400 {"key":"capabilities_retrieve_empty"}`. The matrix is per lane, so the
   * NL-domestic set (HANDT + SSN) is wrong for most cross-border orders. Asking
   * DHL beats hard-coding a country table: NL and BE do offer both, DE/DK/ES/
   * FR/GB/IT/SE do not, and that list is DHL's to change.
   */
  private async resolveOptions(input: {
    fromCountry?: string | null
    toCountry?: string | null
    parcelTypeKey: DhlParcelParcelType
    delivery: DhlParcelOption
    wanted: DhlParcelOption[]
  }): Promise<DhlParcelOption[]> {
    const { parcelTypeKey, delivery, wanted } = input
    const from = (input.fromCountry || "NL").toUpperCase()
    const to = (input.toCountry || "").toUpperCase()

    // Never block a shipment on a capabilities hiccup: keep the proven domestic
    // set at home, and abroad fall back to the delivery option + REFERENCE,
    // which every lane in the shop's region offers.
    const fallback = (): DhlParcelOption[] =>
      to === from || !to
        ? [delivery, ...wanted]
        : [delivery, ...wanted.filter((o) => o.key === "REFERENCE")]

    let capabilities: unknown
    try {
      capabilities = await this.getCapabilitiesCached(from, to)
    } catch (err) {
      this.logger_.warn(
        `[dhl-parcel] could not read DHL capabilities for ${from}->${to}: ${(err as Error).message}; using the fallback option set`,
      )
      return fallback()
    }

    const selection = selectDhlOptions(
      capabilities,
      parcelTypeKey,
      [delivery.key],
      wanted.map((o) => o.key),
    )

    if (!selection) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `DHL levert pakkettype ${parcelTypeKey} met ${
          delivery.key === "PS" ? "Servicepunt" : "Thuisbezorgd"
        } niet op de route ${from} naar ${to}. Kies een andere doosmaat of verzendmethode.`,
      )
    }

    if (selection.dropped.length > 0) {
      this.logger_.info(
        `[dhl-parcel] ${from}->${to} (${selection.productLabel ?? selection.productKey ?? "?"}) does not offer ${selection.dropped.join(", ")}; label created without ${selection.dropped.join(", ")}`,
      )
    }

    const byKey = new Map<string, DhlParcelOption>(
      [delivery, ...wanted].map((o) => [o.key, o]),
    )
    return selection.keys
      .map((key) => byKey.get(key))
      .filter((o): o is DhlParcelOption => Boolean(o))
  }

  private async getCapabilitiesCached(
    fromCountry: string,
    toCountry: string,
  ): Promise<unknown> {
    const key = `${fromCountry}->${toCountry}`
    const hit = this.capabilities_.get(key)
    if (hit && Date.now() - hit.at < CAPABILITIES_TTL_MS) {
      return hit.value
    }
    const value = await this.client.getCapabilities({
      fromCountry,
      toCountry,
      toBusiness: false,
    })
    this.capabilities_.set(key, { at: Date.now(), value })
    return value
  }

  private mapReceiver(address: ShippingAddress, email?: string): DhlParcelContact {
    const { street, number } = splitStreet(address.address_1)
    return {
      name: {
        firstName: address.first_name,
        lastName: address.last_name,
        companyName: address.company,
      },
      address: {
        countryCode: address.country_code ?? "",
        postalCode: address.postal_code ?? "",
        city: address.city ?? "",
        street,
        number,
        // Inovix sells B2C, so receivers are consumers. DHL splits its label
        // capabilities by toBusiness; omitting this makes POST /labels return
        // "capabilities_retrieve_empty" (verified live against the prod gateway).
        isBusiness: false,
      },
      email,
      phoneNumber: address.phone,
    }
  }

  private mapShipper(): DhlParcelContact {
    const s = DHL_PARCEL_SHIPPER
    const { street, number } = splitStreet(s.street)
    return {
      name: { companyName: s.name },
      address: {
        countryCode: s.countryCode,
        postalCode: s.postalCode,
        city: s.city,
        street,
        number,
        isBusiness: true,
      },
      email: s.email || undefined,
      phoneNumber: s.phone || undefined,
    }
  }
}

/**
 * Best-effort split of a Dutch address line into street + trailing house
 * number. Conservative: only splits when the line clearly ends in a number
 * (optionally with a single letter suffix, e.g. "12A" or "12 B"). When it
 * can't tell, it returns the whole line as `street` and leaves `number`
 * undefined.
 *
 * LIMITATION: multi-letter NL house-number suffixes such as "hs", "bis",
 * "III", or "12-A" are NOT split | they fall back to the whole line as
 * `street` with `number` unset. Task 22 must verify live whether DHL accepts a
 * combined street+number in the `street` field, or whether `number` must
 * always be split out.
 */
function splitStreet(line?: string | null): { street: string; number?: string } {
  const value = (line ?? "").trim()
  if (!value) return { street: "" }
  const match = value.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/)
  if (match) {
    return { street: match[1].trim(), number: match[2].replace(/\s+/g, "") }
  }
  return { street: value }
}

export default DhlParcelFulfillmentProviderService
