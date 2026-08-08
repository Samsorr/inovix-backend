jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createStep: (_name: string, fn: any) => fn,
  StepResponse: class {
    constructor(public output: any) {}
  },
}))

// validate-order is pulled in at module resolution time by build-payload's
// `import { findDhlParcelMethod } from "./validate-order"`. Stub the Medusa
// framework deps that validate-order imports so they don't pull in the whole
// framework during jest transforms.
jest.mock("@medusajs/framework/utils", () => {
  class MedusaError extends Error {
    static Types = { INVALID_DATA: "INVALID_DATA", NOT_ALLOWED: "NOT_ALLOWED" }
    public type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  }
  return { MedusaError }
})

import buildPayload from "../steps/build-payload"

const presets = [
  { id: "box_s", parcel_type_key: "SMALL", max_items: 2, name: "Small", length_cm: 20, width_cm: 15, height_cm: 8 },
  { id: "box_m", parcel_type_key: "MEDIUM", max_items: 5, name: "Medium", length_cm: 28, width_cm: 20, height_cm: 12 },
  { id: "box_l", parcel_type_key: "SMALL_MEDIUM", max_items: 10, name: "Small-Medium", length_cm: 40, width_cm: 30, height_cm: 20 },
]

const SAMPLE_SETTINGS_ROW = {
  id: "settings_1",
  shipper_name: "Inovix Warehouse",
  shipper_street: "Magazijnweg",
  shipper_number: "5",
  shipper_postal_code: "1234AB",
  shipper_city: "Amsterdam",
  shipper_country_code: "NL",
  shipper_phone: "+31201234567",
  shipper_email: "ship@inovix-peptides.nl",
}

/**
 * Build a mock container that routes resolve() to the right service by module
 * key. `settingsRows` controls what the settings module returns (defaults to
 * SAMPLE_SETTINGS_ROW); pass `[]` to simulate no saved settings, or pass
 * `"throw"` to simulate the module not being registered at all.
 */
function makeContainer(
  p = presets,
  settingsRows: any[] | "throw" = [SAMPLE_SETTINGS_ROW],
) {
  const boxesService = { listDhlParcelBoxPresets: jest.fn(async () => p) }
  const settingsService =
    settingsRows === "throw"
      ? null
      : { listDhlParcelSettings: jest.fn(async () => settingsRows) }

  return {
    resolve: jest.fn((key: string) => {
      if (key === "dhl_parcel_boxes") return boxesService
      if (key === "dhl_parcel_settings") {
        if (!settingsService) throw new Error("Module dhl_parcel_settings not registered")
        return settingsService
      }
      throw new Error(`Unknown module: ${key}`)
    }),
  } as any
}

function orderWith(methodData: Record<string, any>, items: any[]) {
  return {
    id: "order_1",
    display_id: 1042,
    shipping_methods: [{ shipping_option: { provider_id: "dhl-parcel" }, data: methodData }],
    items,
  }
}

describe("build-payload step (DHL Parcel)", () => {
  it("computes total weight in grams and total units across items", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 2, product: { id: "p1", weight: 150 } },
      { quantity: 3, product: { id: "p2", weight: 10 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    // 2*150 + 3*10 = 330 grams; 2 + 3 = 5 units
    expect(result.output.dhl_total_weight_grams).toBe(330)
    expect(result.output.total_units).toBe(5)
  })

  it("picks the smallest fitting box preset and sets dhl_parcel_type_key + dimensions", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 4, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    // 4 units -> MEDIUM (max_items 5)
    expect(result.output.dhl_parcel_type_key).toBe("MEDIUM")
    expect(result.output.dhl_box_dimensions).toEqual({ length: 28, width: 20, height: 12 })
  })

  it("carries dhl_option DOOR through and does not set a service_point_id", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.dhl_option).toBe("DOOR")
    expect(result.output.service_point_id).toBeUndefined()
  })

  it("carries dhl_option PS and the service_point_id from the method data", async () => {
    const order = orderWith({ dhl_option: "PS", service_point_id: "sp-123" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.dhl_option).toBe("PS")
    expect(result.output.service_point_id).toBe("sp-123")
  })

  it("enriches the carried items with product.weight so the provider can recompute weight", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 2, product: { id: "p1", weight: 150 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.items[0]).toMatchObject({ quantity: 2, product: { weight: 150 } })
  })

  it("does NOT generate a label id (the provider owns it)", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.dhl_label_id).toBeUndefined()
  })

  it("returns the largest preset when units exceed every preset max_items", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 15, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.dhl_parcel_type_key).toBe("SMALL_MEDIUM")
  })

  it("reads dhl_option from the DHL Parcel method even when a non-DHL method is at index 0", async () => {
    // A fee/discount method precedes the DHL Parcel method. The old
    // shipping_methods[0] approach would have picked the wrong method and
    // returned dhl_option: undefined. The shared findDhlParcelMethod finder
    // must skip it and read from the DHL Parcel method.
    const order = {
      id: "order_1",
      display_id: 1042,
      shipping_methods: [
        // Non-DHL method at index 0 (e.g. a discount/fee line)
        { shipping_option: { provider_id: "manual" }, data: { fee_type: "handling" } },
        // The real DHL Parcel method
        {
          shipping_option: { provider_id: "dhl-parcel" },
          data: { dhl_option: "PS", service_point_id: "sp-999" },
        },
      ],
      items: [{ quantity: 1, product: { id: "p1", weight: 100 } }],
    }
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.dhl_option).toBe("PS")
    expect(result.output.service_point_id).toBe("sp-999")
  })

  // ─── Live query.graph quantity shapes ─────────────────────────────────────

  it("resolves quantities that only exist on items.detail", async () => {
    // Same live shape as the picklist (commit bf77956): raw it.quantity
    // arithmetic would make the weight NaN, which the provider reports as the
    // misleading "an order item is missing a product weight", and totalUnits
    // "0[object Object]", which silently picks the largest parcel type.
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: undefined, detail: { quantity: 2 }, product: { id: "p1", weight: 150 } },
      { quantity: undefined, detail: { raw_quantity: { value: "3", precision: 20 } }, product: { id: "p2", weight: 10 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)

    expect(result.output.dhl_total_weight_grams).toBe(330)
    expect(result.output.total_units).toBe(5)
    expect(result.output.dhl_parcel_type_key).toBe("MEDIUM")
  })

  it("carries the resolved quantity on the enriched items", async () => {
    // The provider recomputes weight from these items, so they must carry a
    // real number, not the raw bigNumber object.
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: { value: "2", precision: 20 }, product: { id: "p1", weight: 150 } },
    ])
    const result = await buildPayload({ order } as any, { container: makeContainer() } as any)
    expect(result.output.items[0].quantity).toBe(2)
  })

  it("fails with an explicit message when a quantity cannot be resolved", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { id: "item_1", quantity: undefined, detail: null, product: { id: "p1", title: "BPC-157", weight: 150 } },
    ])
    await expect(
      buildPayload({ order } as any, { container: makeContainer() } as any)
    ).rejects.toThrow(/aantal/i)
  })

  // ─── Settings / shipper tests ─────────────────────────────────────────────

  it("sets dhl_shipper from the settings row when one exists", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload(
      { order } as any,
      { container: makeContainer(presets, [SAMPLE_SETTINGS_ROW]) } as any,
    )

    expect(result.output.dhl_shipper).toEqual({
      name: { companyName: "Inovix Warehouse" },
      address: {
        countryCode: "NL",
        postalCode: "1234AB",
        city: "Amsterdam",
        street: "Magazijnweg",
        number: "5",
        isBusiness: true,
      },
      email: "ship@inovix-peptides.nl",
      phoneNumber: "+31201234567",
    })
  })

  it("sets dhl_shipper.address.number to undefined when shipper_number is null in the row", async () => {
    const rowWithoutNumber = { ...SAMPLE_SETTINGS_ROW, shipper_number: null }
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload(
      { order } as any,
      { container: makeContainer(presets, [rowWithoutNumber]) } as any,
    )

    expect(result.output.dhl_shipper).toMatchObject({
      name: { companyName: "Inovix Warehouse" },
      address: { isBusiness: true },
    })
    expect(result.output.dhl_shipper.address.number).toBeUndefined()
  })

  it("leaves dhl_shipper undefined when the settings module returns an empty list (env fallback)", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload(
      { order } as any,
      { container: makeContainer(presets, []) } as any,
    )

    expect(result.output.dhl_shipper).toBeUndefined()
  })

  it("leaves dhl_shipper undefined when the settings module throws (graceful degradation)", async () => {
    const order = orderWith({ dhl_option: "DOOR" }, [
      { quantity: 1, product: { id: "p1", weight: 100 } },
    ])
    const result = await buildPayload(
      { order } as any,
      { container: makeContainer(presets, "throw") } as any,
    )

    // The step must not throw — it degrades gracefully to env fallback.
    expect(result.output.dhl_shipper).toBeUndefined()
  })
})
