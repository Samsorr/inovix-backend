import { v5 as uuidv5 } from "uuid"
import { DhlParcelApiError } from "../types"

// AbstractFulfillmentProviderService pulls in the whole Medusa framework at
// import time; stub it (and MedusaError) so the service can be unit-tested in
// isolation, mirroring the old DHL Express test.
jest.mock("@medusajs/framework/utils", () => {
  class AbstractFulfillmentProviderService {
    static identifier = ""
  }
  class MedusaError extends Error {
    static Types = { INVALID_DATA: "INVALID_DATA", NOT_ALLOWED: "NOT_ALLOWED" }
    public type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  }
  return { AbstractFulfillmentProviderService, MedusaError }
})

// lib/constants loads env + asserts DATABASE_URL/JWT_SECRET at import time, which
// would throw under jest. Provide stable fakes so the service module imports.
jest.mock("lib/constants", () => ({
  DHL_PARCEL_API_BASE_URL: "https://api.dhl-parcel.test",
  DHL_PARCEL_USER_ID: "test-user",
  DHL_PARCEL_KEY: "test-key",
  DHL_PARCEL_SHIPPER: {
    name: "Inovix",
    street: "Shipperstraat 10",
    postalCode: "1234AB",
    city: "Utrecht",
    countryCode: "NL",
    phone: "+31100000000",
    email: "ops@example.com",
  },
}))

// The hardcoded idempotency namespace must match the one baked into the service.
const DHL_LABEL_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341"

type MockClient = {
  createLabel: jest.Mock
  getLabel: jest.Mock
  getLabelPdf: jest.Mock
  getAccountNumbers: jest.Mock
  tryCancelLabel: jest.Mock
  getCapabilities: jest.Mock
}

// Capability fixtures. The default double is permissive (every option on every
// parcel type) so the tests that are not about lanes keep testing one thing;
// the lane-specific fixtures below mirror real GET /capabilities/business
// responses (prod gateway, 2026-08-08).
function capability(
  productKey: string,
  parcelTypeKey: string,
  optionKeys: string[],
): Record<string, unknown> {
  const EXCLUSIONS: Record<string, string[]> = {
    PS: ["DOOR", "HANDT"],
    DOOR: ["PS"],
    HANDT: ["PS"],
  }
  return {
    product: { key: productKey, label: productKey },
    parcelType: { key: parcelTypeKey },
    options: optionKeys.map((key) => ({
      key,
      exclusions: (EXCLUSIONS[key] ?? []).map((k) => ({ key: k })),
    })),
  }
}

const PERMISSIVE_CAPABILITIES = ["XSMALL", "SMALL", "SMALL_MEDIUM", "MEDIUM"].map((pt) =>
  capability("DFY-B2C", pt, ["DOOR", "PS", "REFERENCE", "HANDT", "SSN"]),
)

// NL -> DE (and DK/ES/FR/GB/IT/SE): DHL PARCEL CONNECT + EUROPLUS. Neither
// offers HANDT or SSN, and XSMALL does not exist on the lane.
const CROSS_BORDER_CAPABILITIES = [
  capability("CON", "SMALL", ["DOOR", "PS", "REFERENCE"]),
  capability("CON", "MEDIUM", ["DOOR", "PS", "REFERENCE"]),
  capability("EPL-INT", "SMALL", ["DOOR", "REFERENCE", "LQ"]),
  capability("EPL-INT", "MEDIUM", ["DOOR", "REFERENCE", "LQ"]),
]

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    createLabel: jest.fn(),
    getLabel: jest.fn(),
    getLabelPdf: jest.fn(),
    getAccountNumbers: jest.fn(async () => ["ACC-0001"]),
    tryCancelLabel: jest.fn(async () => ({ cancelled: true })),
    getCapabilities: jest.fn(async () => PERMISSIVE_CAPABILITIES),
    ...overrides,
  }
}

function makeLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
}

async function makeService(client: MockClient, logger = makeLogger()) {
  const { default: DhlParcelService } = await import("../service")
  const svc: any = new DhlParcelService({ logger } as any, {})
  svc.client = client
  return { svc, logger }
}

const SAMPLE_LABEL_RESPONSE = {
  labelId: "label-abc",
  shipmentId: "shipment-abc",
  parcelType: "MEDIUM",
  pieceNumber: 1,
  trackerCode: "JVGL0123456789NL",
  routingCode: "2LNL1011DL+00540000",
  pdf: "JVBERi0xLjQ=",
}

function sampleOrder() {
  return {
    id: "order_1",
    display_id: 1042,
    email: "klant@example.com",
    currency_code: "eur",
    shipping_address: {
      first_name: "Jan",
      last_name: "Jansen",
      company: "Acme BV",
      address_1: "Klantstraat 12",
      city: "Rotterdam",
      postal_code: "3000AA",
      country_code: "nl",
      phone: "+31600000000",
    },
  }
}

const SAMPLE_ITEMS = [{ quantity: 2, product: { weight: 150 } }]

const BASE_DATA = {
  dhl_option: "DOOR" as const,
  dhl_parcel_type_key: "MEDIUM" as const,
  dhl_box_dimensions: { length: 28, width: 20, height: 12 },
}

describe("DhlParcelFulfillmentProviderService", () => {
  // ─── Test 1: getFulfillmentOptions returns both options ──────────────────────
  it("getFulfillmentOptions returns DOOR and PS options with correct data", async () => {
    const { svc } = await makeService(makeMockClient())
    const options = await svc.getFulfillmentOptions()

    expect(options).toEqual([
      { id: "dhl-thuisbezorgd", name: "DHL Thuisbezorgd", data: { dhl_option: "DOOR" } },
      { id: "dhl-servicepunt", name: "DHL Servicepunt", data: { dhl_option: "PS" } },
    ])
  })

  // ─── Test 2: validateOption checks dhl_option (the option's data field) ──────
  it("validateOption returns true for { dhl_option: 'DOOR' } and { dhl_option: 'PS' }", async () => {
    const { svc } = await makeService(makeMockClient())

    expect(await svc.validateOption({ dhl_option: "DOOR" })).toBe(true)
    expect(await svc.validateOption({ dhl_option: "PS" })).toBe(true)
  })

  it("validateOption returns false for unknown option data", async () => {
    const { svc } = await makeService(makeMockClient())

    // Old wrong shape: the shipping option's top-level id is NOT passed here.
    expect(await svc.validateOption({ id: "dhl-thuisbezorgd" })).toBe(false)
    expect(await svc.validateOption({ id: "dhl-servicepunt" })).toBe(false)
    expect(await svc.validateOption({ dhl_option: "UNKNOWN" })).toBe(false)
    expect(await svc.validateOption({})).toBe(false)
  })

  // ─── Test 3: validateFulfillmentData PS guard ────────────────────────────────
  it("validateFulfillmentData throws when PS is chosen but service_point_id is missing/empty", async () => {
    const { svc } = await makeService(makeMockClient())

    await expect(
      svc.validateFulfillmentData({ dhl_option: "PS" }, {}, {}),
    ).rejects.toThrow()

    await expect(
      svc.validateFulfillmentData({ dhl_option: "PS" }, { service_point_id: "" }, {}),
    ).rejects.toThrow()
  })

  it("validateFulfillmentData passes for PS with a service_point_id and for DOOR", async () => {
    const { svc } = await makeService(makeMockClient())

    const ps = await svc.validateFulfillmentData(
      { dhl_option: "PS" },
      { service_point_id: "sp-123" },
      {},
    )
    expect(ps).toMatchObject({ dhl_option: "PS", service_point_id: "sp-123" })

    const door = await svc.validateFulfillmentData({ dhl_option: "DOOR" }, {}, {})
    expect(door).toMatchObject({ dhl_option: "DOOR" })
  })

  // ─── Test 4: createFulfillment happy path ────────────────────────────────────
  it("createFulfillment calls createLabel with the correct input shape and returns tracking data", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const order = sampleOrder()
    const result = await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, order, {})

    // Called exactly once
    expect(client.createLabel).toHaveBeenCalledTimes(1)

    const input = client.createLabel.mock.calls[0][0]

    // Deterministic labelId from display_id
    const expectedLabelId = uuidv5(`${order.id}-1`, DHL_LABEL_NAMESPACE)
    expect(input.labelId).toBe(expectedLabelId)

    // parcel type from data
    expect(input.parcelTypeKey).toBe("MEDIUM")

    // account id from client.getAccountNumbers()[0]
    expect(input.accountId).toBe("ACC-0001")

    // receiver mapped from shipping address
    expect(input.receiver).toMatchObject({
      name: { firstName: "Jan", lastName: "Jansen", companyName: "Acme BV" },
      address: { countryCode: "nl", postalCode: "3000AA", city: "Rotterdam" },
      email: "klant@example.com",
      phoneNumber: "+31600000000",
    })

    // options: DOOR + REFERENCE + HANDT (signature required; HANDT only on DOOR per capabilities)
    expect(input.options).toEqual([
      { key: "DOOR" },
      { key: "REFERENCE", input: "1042" },
      { key: "HANDT" },
    ])

    // pieces: weight from items (2 * 150 = 300), dimensions from data
    expect(input.pieces).toEqual([
      { weight: 300, dimensions: { length: 28, width: 20, height: 12 } },
    ])

    // Return shape
    expect(result.data).toMatchObject({
      dhl_label_id: expectedLabelId,
      dhl_tracking_number: "JVGL0123456789NL",
    })
    expect(result.data.dhl_label_pdf_url).toBe("data:application/pdf;base64,JVBERi0xLjQ=")
    expect(result.data.dhl_shipment_tracking_url).toBe(
      "https://my.dhlecommerce.nl/home/tracktrace/JVGL0123456789NL/3000AA?lang=nl_NL",
    )

    expect(result.labels).toEqual([
      {
        tracking_number: "JVGL0123456789NL",
        tracking_url:
          "https://my.dhlecommerce.nl/home/tracktrace/JVGL0123456789NL/3000AA?lang=nl_NL",
        label_url: "data:application/pdf;base64,JVBERi0xLjQ=",
      },
    ])
  })

  // ─── The customer note must NEVER reach DHL ──────────────────────────────────
  // The note is addressed to Inovix, not the courier (operator decision,
  // 2026-07-24). The label payload is a fixed whitelist with no free-text
  // field, and this test is what keeps it that way: adding any order-metadata
  // passthrough to the label input will fail here.
  it("createFulfillment never sends the customer note to DHL", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const NOTE = "GEHEIME-KLANTOPMERKING-graag-bij-de-buren"
    const order = {
      ...sampleOrder(),
      metadata: { customer_note: NOTE, delivery_notes: NOTE },
    }

    await svc.createFulfillment(
      // Also smuggle it in through the fulfillment data, the other plausible
      // route into the payload.
      { ...BASE_DATA, customer_note: NOTE } as never,
      SAMPLE_ITEMS,
      order,
      {},
    )

    const input = client.createLabel.mock.calls[0][0]
    expect(JSON.stringify(input)).not.toContain(NOTE)
    expect(JSON.stringify(input)).not.toContain("KLANTOPMERKING")

    // The only free-ish input DHL gets is the order number as REFERENCE.
    const referenceInputs = (input.options as Array<{ key: string; input?: string }>)
      .filter((o) => o.key === "REFERENCE")
      .map((o) => o.input)
    expect(referenceInputs).toEqual(["1042"])
  })

  // ─── Test 5: createFulfillment idempotency ───────────────────────────────────
  it("createFulfillment is idempotent: skips the client when dhl_tracking_number is already set", async () => {
    const client = makeMockClient()
    const { svc } = await makeService(client)

    const existing = {
      ...BASE_DATA,
      dhl_label_id: "existing-label-id",
      dhl_tracking_number: "JVGL-EXISTING",
      dhl_label_pdf_url: "data:application/pdf;base64,PREV",
      dhl_shipment_tracking_url: "https://track/prev",
    }

    const result = await svc.createFulfillment(existing, SAMPLE_ITEMS, sampleOrder(), {})

    expect(client.createLabel).not.toHaveBeenCalled()
    expect(client.getAccountNumbers).not.toHaveBeenCalled()
    expect(result.data).toMatchObject({ dhl_tracking_number: "JVGL-EXISTING" })
    expect(result.labels).toEqual([
      {
        tracking_number: "JVGL-EXISTING",
        tracking_url: "https://track/prev",
        label_url: "data:application/pdf;base64,PREV",
      },
    ])
  })

  // ─── Test 5b: createFulfillment recovers from a DHL 409 (idempotent) ─────────
  it("createFulfillment recovers from any 409 (e.g. tracker_code_conflict) by returning the existing label", async () => {
    const client = makeMockClient()
    client.createLabel.mockRejectedValue(
      new DhlParcelApiError(
        "DHL Parcel POST /labels failed with 409",
        409,
        { key: "tracker_code_conflict", message: "Request id x was already used by another (different) request" },
        "https://api.dhl-parcel.test/labels",
      ),
    )
    client.getLabel.mockResolvedValue({
      ...SAMPLE_LABEL_RESPONSE,
      trackerCode: "JVGL-EXISTING",
      pdf: "RVhJU1RJTkc=",
    })
    const { svc, logger } = await makeService(client)

    const order = sampleOrder()
    const result = await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, order, {})

    const expectedLabelId = uuidv5(`${order.id}-1`, DHL_LABEL_NAMESPACE)
    expect(client.createLabel).toHaveBeenCalledTimes(1)
    expect(client.getLabel).toHaveBeenCalledWith(expectedLabelId)
    // Returns the EXISTING label's tracking + pdf, as if freshly created.
    expect(result.data).toMatchObject({
      dhl_label_id: expectedLabelId,
      dhl_tracking_number: "JVGL-EXISTING",
    })
    expect(result.data.dhl_label_pdf_url).toBe("data:application/pdf;base64,RVhJU1RJTkc=")
    expect(result.labels[0]).toMatchObject({
      tracking_number: "JVGL-EXISTING",
      label_url: "data:application/pdf;base64,RVhJU1RJTkc=",
    })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("already exists"))
  })

  // ─── Test 5c: non-409 DHL errors propagate (no existing-label fetch) ─────────
  it("createFulfillment rethrows non-409 DHL errors and does not fetch an existing label", async () => {
    const client = makeMockClient()
    client.createLabel.mockRejectedValue(
      new DhlParcelApiError(
        "DHL Parcel POST /labels failed with 400",
        400,
        { key: "validation_error" },
        "https://api.dhl-parcel.test/labels",
      ),
    )
    const { svc } = await makeService(client)

    await expect(
      svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, sampleOrder(), {}),
    ).rejects.toThrow()
    expect(client.getLabel).not.toHaveBeenCalled()
  })

  // ─── Test 6: createFulfillment PS option ─────────────────────────────────────
  it("createFulfillment with PS option includes { key: 'PS', input: <service_point_id> } exactly once", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const data = { ...BASE_DATA, dhl_option: "PS" as const, service_point_id: "sp-999" }
    await svc.createFulfillment(data, SAMPLE_ITEMS, sampleOrder(), {})

    const input = client.createLabel.mock.calls[0][0]
    // PS shipments do NOT get HANDT (mutually exclusive per DHL capabilities)
    expect(input.options).toEqual([
      { key: "PS", input: "sp-999" },
      { key: "REFERENCE", input: "1042" },
    ])

    const psCount = input.options.filter((o: { key: string }) => o.key === "PS").length
    expect(psCount).toBe(1)
    const handtCount = input.options.filter((o: { key: string }) => o.key === "HANDT").length
    expect(handtCount).toBe(0)
  })

  // ─── Test 7: cancelFulfillment logs via container logger, never throws ────────
  it("cancelFulfillment returns {} even when tryCancelLabel reports cancelled:false, and logs via logger_.warn", async () => {
    const client = makeMockClient({
      tryCancelLabel: jest.fn(async () => ({ cancelled: false })),
    })
    const { svc, logger } = await makeService(client)

    const result = await svc.cancelFulfillment({ dhl_label_id: "label-xyz" })

    expect(client.tryCancelLabel).toHaveBeenCalledWith("label-xyz")
    expect(result).toEqual({})
    // Unsupported cancellation is logged via the container logger, not console.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("label-xyz"),
    )
  })

  // ─── Test 8: createFulfillment uses dhl_shipper from data when present ───────
  it("createFulfillment uses data.dhl_shipper when provided (admin-saved warehouse address)", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const adminShipper = {
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
    }

    const dataWithShipper = { ...BASE_DATA, dhl_shipper: adminShipper }
    await svc.createFulfillment(dataWithShipper, SAMPLE_ITEMS, sampleOrder(), {})

    const input = client.createLabel.mock.calls[0][0]
    // Must use the admin shipper, NOT the env constant.
    expect(input.shipper).toEqual(adminShipper)
  })

  // ─── Test 9: createFulfillment falls back to env shipper when dhl_shipper absent ─
  it("createFulfillment falls back to the env shipper (mapShipper) when data.dhl_shipper is absent", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    // BASE_DATA has no dhl_shipper field.
    await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, sampleOrder(), {})

    const input = client.createLabel.mock.calls[0][0]
    // The env constant is mocked above: name "Inovix", street "Shipperstraat 10", etc.
    // mapShipper() splits "Shipperstraat 10" into street + number.
    expect(input.shipper.name).toEqual({ companyName: "Inovix" })
    expect(input.shipper.address.countryCode).toBe("NL")
    expect(input.shipper.address.city).toBe("Utrecht")
    expect(input.shipper.address.isBusiness).toBe(true)
  })

  // ─── Test 10: SSN (hidden sender) option ─────────────────────────────────────
  it("createFulfillment adds the SSN option when data.dhl_hide_sender is true", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: true }, SAMPLE_ITEMS, sampleOrder(), {})

    const input = client.createLabel.mock.calls[0][0]
    expect(input.options).toContainEqual({ key: "SSN" })
  })

  it("createFulfillment omits the SSN option when dhl_hide_sender is false or absent", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: false }, SAMPLE_ITEMS, sampleOrder(), {})
    const offInput = client.createLabel.mock.calls[0][0]
    expect(offInput.options.some((o: { key: string }) => o.key === "SSN")).toBe(false)

    // BASE_DATA has no dhl_hide_sender field at all -> also no SSN.
    client.createLabel.mockClear()
    await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, sampleOrder(), {})
    const absentInput = client.createLabel.mock.calls[0][0]
    expect(absentInput.options.some((o: { key: string }) => o.key === "SSN")).toBe(false)
  })

  // ─── Cross-border lanes: options must match DHL's per-lane capabilities ──────
  // Order #28416 (NL -> DE, 2026-08-08) failed five times with
  // "DHL Parcel POST /labels failed with 400" because the payload carried HANDT
  // and SSN. DHL PARCEL CONNECT does not offer either, and DHL rejects the whole
  // label (400 capabilities_retrieve_empty) instead of ignoring the option.
  it("createFulfillment drops HANDT and SSN for a lane that does not offer them (NL -> DE)", async () => {
    const client = makeMockClient({
      getCapabilities: jest.fn(async () => CROSS_BORDER_CAPABILITIES),
    })
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const order = sampleOrder()
    order.shipping_address.country_code = "de"
    order.shipping_address.postal_code = "14827"
    order.shipping_address.city = "Wiesenburg/Mark"

    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: true }, SAMPLE_ITEMS, order, {})

    expect(client.getCapabilities).toHaveBeenCalledWith({
      fromCountry: "NL",
      toCountry: "DE",
      toBusiness: false,
    })
    const input = client.createLabel.mock.calls[0][0]
    expect(input.options).toEqual([{ key: "DOOR" }, { key: "REFERENCE", input: "1042" }])
  })

  it("createFulfillment keeps HANDT and SSN on a lane that offers them (NL -> NL)", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: true }, SAMPLE_ITEMS, sampleOrder(), {})

    const input = client.createLabel.mock.calls[0][0]
    expect(input.options).toEqual([
      { key: "DOOR" },
      { key: "REFERENCE", input: "1042" },
      { key: "HANDT" },
      { key: "SSN" },
    ])
  })

  it("createFulfillment refuses (with a Dutch message) when the lane cannot carry the parcel type", async () => {
    const client = makeMockClient({
      // XSMALL exists NL -> NL but not on the cross-border lane.
      getCapabilities: jest.fn(async () => CROSS_BORDER_CAPABILITIES),
    })
    const { svc } = await makeService(client)

    const order = sampleOrder()
    order.shipping_address.country_code = "de"

    await expect(
      svc.createFulfillment({ ...BASE_DATA, dhl_parcel_type_key: "XSMALL" }, SAMPLE_ITEMS, order, {}),
    ).rejects.toThrow(/XSMALL/)
    expect(client.createLabel).not.toHaveBeenCalled()
  })

  it("createFulfillment caches capabilities per lane instead of asking DHL for every label", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, sampleOrder(), {})
    await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, sampleOrder(), {})

    expect(client.getCapabilities).toHaveBeenCalledTimes(1)
    expect(client.createLabel).toHaveBeenCalledTimes(2)
  })

  it("createFulfillment still ships when the capabilities lookup fails: full set at home, minimal abroad", async () => {
    const client = makeMockClient({
      getCapabilities: jest.fn(async () => {
        throw new Error("DHL Parcel GET /capabilities/business failed with 503")
      }),
    })
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc, logger } = await makeService(client)

    // Domestic: keep the option set that is known to work NL -> NL.
    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: true }, SAMPLE_ITEMS, sampleOrder(), {})
    expect(client.createLabel.mock.calls[0][0].options).toEqual([
      { key: "DOOR" },
      { key: "REFERENCE", input: "1042" },
      { key: "HANDT" },
      { key: "SSN" },
    ])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("capabilities"))

    // Abroad: fall back to the subset every lane accepts rather than risk a 400.
    client.createLabel.mockClear()
    const order = sampleOrder()
    order.shipping_address.country_code = "de"
    await svc.createFulfillment({ ...BASE_DATA, dhl_hide_sender: true }, SAMPLE_ITEMS, order, {})
    expect(client.createLabel.mock.calls[0][0].options).toEqual([
      { key: "DOOR" },
      { key: "REFERENCE", input: "1042" },
    ])
  })

  // ─── Test 11: labelId rotates with the attempt number (redo after cancel) ────
  it("createFulfillment seeds a fresh labelId from order.label_attempt (redo)", async () => {
    const client = makeMockClient()
    client.createLabel.mockResolvedValue(SAMPLE_LABEL_RESPONSE)
    const { svc } = await makeService(client)

    const order = { ...sampleOrder(), label_attempt: 2 }
    await svc.createFulfillment(BASE_DATA, SAMPLE_ITEMS, order, {})

    const input = client.createLabel.mock.calls[0][0]
    expect(input.labelId).toBe(uuidv5(`${order.id}-2`, DHL_LABEL_NAMESPACE))
    // Different from the first-attempt id, so DHL won't 409-collide with the old label.
    expect(input.labelId).not.toBe(uuidv5(`${order.id}-1`, DHL_LABEL_NAMESPACE))
  })
})
