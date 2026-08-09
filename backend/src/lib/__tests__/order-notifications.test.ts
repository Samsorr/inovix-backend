jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: { QUERY: "query" },
  Modules: { NOTIFICATION: "notification", EVENT_BUS: "event_bus" },
}))

import {
  getNotification,
  listOrderEmails,
  resendOrderConfirmation,
  resendOrderEmail,
  sentOverridesFromData,
} from "../order-notifications"

const ORDER_ID = "order_abc"

function makeContainer(rows: any[] = []) {
  const listNotifications = jest.fn().mockImplementation((filters: any = {}) => {
    let out = rows
    if (filters.id) out = out.filter((r) => r.id === filters.id)
    if (filters.resource_id) out = out.filter((r) => r.resource_id === filters.resource_id)
    if (filters.template) out = out.filter((r) => r.template === filters.template)
    return Promise.resolve(out)
  })
  const createNotifications = jest.fn().mockResolvedValue(undefined)
  const emit = jest.fn().mockResolvedValue(undefined)
  const container: any = {
    resolve: (key: string) => {
      if (key === "notification") return { listNotifications, createNotifications }
      if (key === "event_bus") return { emit }
      throw new Error(`unexpected resolve: ${key}`)
    },
  }
  return { container, listNotifications, createNotifications, emit }
}

function confirmationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "noti_1",
    to: "buyer@example.com",
    channel: "email",
    template: "order-placed",
    status: "success",
    resource_id: ORDER_ID,
    resource_type: "order",
    idempotency_key: `order-confirmed-${ORDER_ID}`,
    data: { emailOptions: { subject: "Bestelling bevestigd" } },
    created_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  }
}

describe("resendOrderEmail", () => {
  it("uses a unique key and keeps the row attributable to its order", async () => {
    const { container, createNotifications } = makeContainer([confirmationRow()])

    const result = await resendOrderEmail(container, "noti_1")

    expect(result).toMatchObject({ ok: true, template: "order-placed" })
    const call = createNotifications.mock.calls[0][0]
    expect(call.idempotency_key).toMatch(
      new RegExp(`^order-confirmed-${ORDER_ID}-resend-\\d+$`)
    )
    // Dropped before, which made resent emails unattributable.
    expect(call.resource_id).toBe(ORDER_ID)
    expect(call.resource_type).toBe("order")
    expect(call.trigger_type).toBe("admin.resend")
    expect(call.original_notification_id).toBe("noti_1")
  })

  it("reports a Resend failure instead of a green toast over a dropped email", async () => {
    const { container, createNotifications } = makeContainer([confirmationRow()])
    createNotifications.mockRejectedValueOnce(
      new Error('Failed to send "order-placed" email via Resend: not_authorized')
    )

    const result = await resendOrderEmail(container, "noti_1")

    expect(result).toMatchObject({ ok: false, reason: "error" })
    expect((result as any).message).toMatch(/not_authorized/)
  })

  it("reports not_found for an unknown notification", async () => {
    const { container } = makeContainer([])
    expect(await resendOrderEmail(container, "noti_missing")).toEqual({
      ok: false,
      reason: "not_found",
    })
  })
})

describe("resendOrderConfirmation", () => {
  // Re-emitting order.placed reuses `order-confirmed-<id>`, which the
  // notification module skips. That is why the button was a silent no-op.
  it("replays the stored confirmation rather than re-emitting the event", async () => {
    const { container, createNotifications, emit } = makeContainer([confirmationRow()])

    const result = await resendOrderConfirmation(container, ORDER_ID)

    expect(result).toMatchObject({ ok: true, resent: true, to: "buyer@example.com" })
    expect(emit).not.toHaveBeenCalled()
    expect(createNotifications).toHaveBeenCalledTimes(1)
    expect(createNotifications.mock.calls[0][0].idempotency_key).not.toBe(
      `order-confirmed-${ORDER_ID}`
    )
  })

  it("prefers a successful row over a failed one", async () => {
    const rows = [
      confirmationRow({ id: "noti_failed", status: "failure" }),
      confirmationRow({ id: "noti_ok", status: "success" }),
    ]
    const { container, createNotifications } = makeContainer(rows)

    await resendOrderConfirmation(container, ORDER_ID)

    expect(createNotifications.mock.calls[0][0].original_notification_id).toBe("noti_ok")
  })

  it("emits order.placed when the order never got a confirmation", async () => {
    const { container, createNotifications, emit } = makeContainer([])

    const result = await resendOrderConfirmation(container, ORDER_ID)

    expect(result).toMatchObject({ ok: true, emitted: true })
    expect(emit).toHaveBeenCalledWith({
      name: "order.placed",
      data: { id: ORDER_ID },
    })
    expect(createNotifications).not.toHaveBeenCalled()
  })

  it("surfaces a failed replay as ok: false", async () => {
    const { container, createNotifications } = makeContainer([confirmationRow()])
    createNotifications.mockRejectedValueOnce(new Error("Resend: rate_limit_exceeded"))

    const result = await resendOrderConfirmation(container, ORDER_ID)

    expect(result).toMatchObject({ ok: false, reason: "error" })
  })
})

describe("listOrderEmails edited flag", () => {
  const BUYER = "buyer@example.com"

  function makeListContainer(rows: any[]) {
    const listNotifications = jest.fn().mockResolvedValue(rows)
    const graph = jest.fn().mockResolvedValue({ data: [{ id: ORDER_ID, email: BUYER }] })
    const container: any = {
      resolve: (key: string) => {
        if (key === "notification") return { listNotifications }
        if (key === "query") return { graph }
        throw new Error(`unexpected resolve: ${key}`)
      },
    }
    return { container, listNotifications }
  }

  function row(id: string, data: unknown) {
    return {
      id,
      to: BUYER,
      channel: "email",
      template: "order-shipped",
      status: "success",
      idempotency_key: `key-${id}`,
      created_at: "2026-08-01T10:00:00.000Z",
      data,
    }
  }

  it("flags an email as edited when the stored data carries overrides", async () => {
    const { container } = makeListContainer([
      row("noti_edited", { emailOptions: {}, overrides: { body: "x" } }),
      row("noti_empty", { emailOptions: {}, overrides: {} }),
      row("noti_bare", undefined),
    ])

    const { notifications } = await listOrderEmails(container, ORDER_ID)

    expect(notifications.map((n) => n.edited)).toEqual([true, false, false])
  })

  // A subject-only edit leaves `overrides` empty (the subject moves into
  // emailOptions), so `data.edited` is the only honest marker. applyOverrides
  // stamps it, and the badge must read it.
  it("does not read a subject-only edit as unedited", async () => {
    const { container } = makeListContainer([
      row("noti_subject_only", {
        emailOptions: { subject: "Eigen onderwerp" },
        edited: true,
      }),
    ])

    const { notifications } = await listOrderEmails(container, ORDER_ID)

    expect(notifications[0].edited).toBe(true)
  })

  it("ignores a non-object overrides value instead of counting its characters", async () => {
    const { container } = makeListContainer([
      row("noti_string", { overrides: "body" }),
      row("noti_array", { overrides: ["body"] }),
      row("noti_null_data", null),
    ])

    const { notifications } = await listOrderEmails(container, ORDER_ID)

    expect(notifications.map((n) => n.edited)).toEqual([false, false, false])
  })

  it("returns edited on a single notification too", async () => {
    const { container } = makeListContainer([
      row("noti_edited", { overrides: { trackButton: "Volg" } }),
    ])

    const single = await getNotification(container, "noti_edited")

    expect(single).toMatchObject({ id: "noti_edited", edited: true })
  })
})

describe("sentOverridesFromData", () => {
  it("returns null for an untouched send", () => {
    expect(sentOverridesFromData({ emailOptions: { subject: "Standaard" } })).toBeNull()
    expect(sentOverridesFromData(null)).toBeNull()
    expect(sentOverridesFromData({ overrides: {} })).toBeNull()
  })

  it("replays the rewritten fields plus the subject it was sent with", () => {
    expect(
      sentOverridesFromData({
        edited: true,
        emailOptions: { subject: "Eigen onderwerp" },
        overrides: { body: "Eigen tekst", trackButton: "Volg" },
      })
    ).toEqual({ body: "Eigen tekst", trackButton: "Volg", subject: "Eigen onderwerp" })
  })

  it("replays a subject-only edit, which never reaches the overrides object", () => {
    expect(
      sentOverridesFromData({ edited: true, emailOptions: { subject: "Alleen onderwerp" } })
    ).toEqual({ subject: "Alleen onderwerp" })
  })

  it("ignores non-string override values", () => {
    expect(
      sentOverridesFromData({ edited: true, overrides: { body: "Tekst", bad: 42 } })
    ).toEqual({ body: "Tekst" })
  })
})
