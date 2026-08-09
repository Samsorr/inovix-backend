import {
  changedOverrides,
  defaultValues,
  draftUrl,
  ORDER_SHIPPED_TEMPLATE,
  PREVIEW_DEBOUNCE_MS,
  sendOutcomeToast,
  sendRequestFor,
  serverErrorText,
  type ComposerField,
} from "../email-composer.logic"

const FIELDS: ComposerField[] = [
  { key: "subject", label: "Onderwerp", type: "text", maxLength: 200, value: "Uw bestelling is onderweg" },
  { key: "body", label: "Inleiding", type: "textarea", maxLength: 2000, value: "Standaardtekst." },
  { key: "trackingUrl", label: "Tracking-link", type: "url", maxLength: 500, value: "https://my.dhlecommerce.nl/x" },
]

describe("defaultValues", () => {
  test("starts every field at the text the customer would get", () => {
    expect(defaultValues(FIELDS)).toEqual({
      subject: "Uw bestelling is onderweg",
      body: "Standaardtekst.",
      trackingUrl: "https://my.dhlecommerce.nl/x",
    })
  })

  test("tolerates an empty or malformed field list", () => {
    expect(defaultValues([])).toEqual({})
    expect(defaultValues([{ key: "a" }, null] as never)).toEqual({ a: "" })
  })
})

describe("changedOverrides", () => {
  const defaults = defaultValues(FIELDS)

  test("an untouched form sends nothing, so the mail is not marked edited", () => {
    expect(changedOverrides(defaults, { ...defaults })).toEqual({})
  })

  test("only the rewritten fields are sent", () => {
    const out = changedOverrides(defaults, {
      ...defaults,
      body: "Wij hebben uw pakket vanmiddag afgegeven bij DHL.",
    })
    expect(out).toEqual({ body: "Wij hebben uw pakket vanmiddag afgegeven bij DHL." })
  })

  test("a cleared field is omitted, because the server restores the default anyway", () => {
    expect(changedOverrides(defaults, { ...defaults, body: "" })).toEqual({})
    expect(changedOverrides(defaults, { ...defaults, body: "   " })).toEqual({})
  })

  test("a stray trailing space is not an edit", () => {
    expect(changedOverrides(defaults, { ...defaults, subject: "Uw bestelling is onderweg  " })).toEqual({})
  })

  test("a field with no known default counts as edited once it has content", () => {
    expect(changedOverrides({}, { heading: "Kop" })).toEqual({ heading: "Kop" })
    expect(changedOverrides({}, { heading: "" })).toEqual({})
  })

  test("ignores non-string values instead of shipping them to the server", () => {
    expect(changedOverrides(defaults, { body: 42 } as never)).toEqual({})
  })
})

describe("sendRequestFor", () => {
  test("order-shipped goes to the DHL route, which also marks the order shipped", () => {
    expect(sendRequestFor("order_1", ORDER_SHIPPED_TEMPLATE, { body: "x" })).toEqual({
      url: "/admin/orders/order_1/dhl-label/send-email",
      body: { resend: true, overrides: { body: "x" } },
    })
  })

  test("every other template goes to the generic send route", () => {
    expect(sendRequestFor("order_1", "order-placed", {})).toEqual({
      url: "/admin/orders/order_1/email/send",
      body: { template: "order-placed", overrides: {} },
    })
  })
})

describe("serverErrorText", () => {
  test("shows the message and the per-field errors together", () => {
    expect(
      serverErrorText(400, {
        message: "Controleer de ingevulde velden",
        errors: ['Veld "Knoptekst" is te lang (max 60 tekens).'],
      })
    ).toBe('Controleer de ingevulde velden Veld "Knoptekst" is te lang (max 60 tekens).')
  })

  test("falls back to the status code when the server said nothing useful", () => {
    expect(serverErrorText(500, {})).toBe("Mislukt (500).")
    expect(serverErrorText(500, null)).toBe("Mislukt (500).")
  })

  test("ignores a non-array errors field", () => {
    expect(serverErrorText(400, { message: "Fout", errors: "kapot" } as never)).toBe("Fout")
  })
})

describe("sendOutcomeToast", () => {
  test("a 200 with sent:false is a warning, not a green toast", () => {
    const out = sendOutcomeToast({ sent: false, reason: "already_sent" }, "klant@example.com")
    expect(out.tone).toBe("warning")
    expect(out.title).toBe("Geen e-mail verstuurd")
    expect(out.description).toContain("klant@example.com")
  })

  test("names the reason it does not recognise", () => {
    expect(sendOutcomeToast({ sent: false, reason: "iets_nieuws" }, "k@x.nl").description).toContain(
      "iets_nieuws"
    )
    expect(sendOutcomeToast({ sent: false }, "k@x.nl").description).toContain("onbekende reden")
    expect(sendOutcomeToast(null, "k@x.nl").tone).toBe("warning")
  })

  test("an in-flight or exhausted send explains itself in Dutch", () => {
    expect(sendOutcomeToast({ sent: false, reason: "in_flight" }, "k@x.nl").description).toContain(
      "Wacht even"
    )
    expect(
      sendOutcomeToast({ sent: false, reason: "retry_budget_exhausted" }, "k@x.nl").description
    ).toContain("te vaak mislukt")
  })

  test("a real send reports whether it went out edited", () => {
    expect(sendOutcomeToast({ sent: true, edited: true }, "k@x.nl")).toEqual({
      tone: "success",
      title: "Bewerkte e-mail verstuurd",
      description: "Verstuurd naar k@x.nl.",
    })
    expect(sendOutcomeToast({ sent: true, edited: false }, "").title).toBe("E-mail verstuurd")
    expect(sendOutcomeToast({ sent: true }, "").description).toBe("Verstuurd naar de klant.")
  })
})

describe("draftUrl", () => {
  test("carries the template and, when pinned, the fulfillment", () => {
    expect(draftUrl("order_1", "order-placed")).toBe(
      "/admin/orders/order_1/email/draft?template=order-placed"
    )
    expect(draftUrl("order_1", "order-shipped", "ful_1")).toBe(
      "/admin/orders/order_1/email/draft?template=order-shipped&fulfillment_id=ful_1"
    )
  })
})

describe("constants", () => {
  test("the preview waits out the operator's typing", () => {
    expect(PREVIEW_DEBOUNCE_MS).toBe(400)
  })
})
