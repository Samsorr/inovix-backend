// Pure helpers for the order email composer drawer, split out so they are unit
// testable without rendering the drawer (same pattern as the widget .logic.ts
// files next door).

export type ComposerFieldType = "text" | "textarea" | "url"

/** One editable field as GET /admin/orders/:id/email/draft returns it. */
export type ComposerField = {
  key: string
  label: string
  type: ComposerFieldType
  maxLength: number
  /** Optional Dutch note under the input. */
  hint?: string
  value: string
}

export type EmailDraft = {
  template: string
  to: string
  locale: string
  fields: ComposerField[]
}

/**
 * The one template whose send carries a side effect (markDhlOrderShipped sets
 * shipped_at and closes the order), so it must NOT go through the generic
 * email/send route | that route refuses it with a 400 by design.
 */
export const ORDER_SHIPPED_TEMPLATE = "order-shipped"

/** Milliseconds of quiet typing before the preview is re-rendered. */
export const PREVIEW_DEBOUNCE_MS = 400

/** The form's starting state: every field at the text the customer would get. */
export function defaultValues(fields: ComposerField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields ?? []) {
    if (!field || typeof field.key !== "string") continue
    out[field.key] = typeof field.value === "string" ? field.value : ""
  }
  return out
}

/**
 * Only the fields the operator really rewrote.
 *
 * Load-bearing: the backend stores whatever arrives here as `data.overrides`,
 * and a non-empty object is what makes the mail read "Bewerkt" forever after.
 * Sending back every field would mark every send as edited and freeze today's
 * template text into the row, so an unedited send must produce {}.
 */
export function changedOverrides(
  defaults: Record<string, string>,
  values: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(values ?? {})) {
    const value = values[key]
    if (typeof value !== "string") continue
    const fallback = typeof defaults?.[key] === "string" ? defaults[key] : ""
    // Trim-compared: a stray trailing space is not an edit, and a "Bewerkt"
    // badge earned by one would make the badge meaningless.
    if (value.trim() === fallback.trim()) continue
    // Cleared field: the server drops empty values and restores the standard
    // text, so sending it would only add a false "edited" marker.
    if (value.trim().length === 0) continue
    out[key] = value
  }
  return out
}

export type SendRequest = { url: string; body: Record<string, unknown> }

/**
 * Where an edited mail is posted.
 *
 * order-shipped goes to the DHL send-email route because that is the only path
 * that also marks the order shipped; anything else goes to the generic route.
 * `resend: true` is deliberate: the operator pressed "Versturen", so the base
 * idempotency key must not be allowed to swallow the send.
 */
export function sendRequestFor(
  orderId: string,
  template: string,
  overrides: Record<string, string>
): SendRequest {
  if (template === ORDER_SHIPPED_TEMPLATE) {
    return {
      url: `/admin/orders/${orderId}/dhl-label/send-email`,
      body: { resend: true, overrides },
    }
  }
  return {
    url: `/admin/orders/${orderId}/email/send`,
    body: { template, overrides },
  }
}

export type ServerErrorBody = {
  message?: string
  errors?: string[]
}

/**
 * The server answers in Dutch, with per-field messages in `errors`. Both are
 * shown: "Controleer de ingevulde velden" alone does not say which field.
 */
export function serverErrorText(
  status: number,
  body: ServerErrorBody | null | undefined
): string {
  const parts: string[] = []
  if (body && typeof body.message === "string" && body.message.length > 0) {
    parts.push(body.message)
  }
  const errors = body && Array.isArray(body.errors) ? body.errors : []
  for (const error of errors) {
    if (typeof error === "string" && error.length > 0) parts.push(error)
  }
  if (parts.length === 0) parts.push(`Mislukt (${status}).`)
  return parts.join(" ")
}

export type SendOutcome = {
  sent?: boolean
  edited?: boolean
  already_shipped?: boolean
  reason?: string
}

export type ComposerToast = {
  tone: "success" | "warning"
  title: string
  description: string
}

/**
 * What to tell the operator after a 200. A 200 does NOT mean an email left the
 * building: the notification module skips an already-sent or in-flight key and
 * the route reports that in `sent` + `reason`, so a green toast over a skipped
 * send would be a lie.
 */
export function sendOutcomeToast(
  outcome: SendOutcome | null | undefined,
  to: string
): ComposerToast {
  const recipient = to && to.length > 0 ? to : "de klant"
  if (!outcome || outcome.sent !== true) {
    const reason = outcome?.reason
    let description: string
    if (reason === "already_sent") {
      description = `${recipient} heeft deze e-mail al ontvangen.`
    } else if (reason === "in_flight") {
      description =
        "Er wordt op dit moment al een e-mail verstuurd. Wacht even en probeer het opnieuw."
    } else if (reason === "retry_budget_exhausted") {
      description =
        "Deze e-mail is te vaak mislukt en wordt niet nog een keer geprobeerd. Zoek eerst uit waarom."
    } else {
      description = `De e-mail is niet verstuurd (${reason ?? "onbekende reden"}).`
    }
    return { tone: "warning", title: "Geen e-mail verstuurd", description }
  }
  return {
    tone: "success",
    title: outcome.edited === true ? "Bewerkte e-mail verstuurd" : "E-mail verstuurd",
    description: `Verstuurd naar ${recipient}.`,
  }
}

/** Query string for the draft and preview calls, kept in one place. */
export function draftUrl(
  orderId: string,
  template: string,
  fulfillmentId?: string
): string {
  const params = new URLSearchParams({ template })
  if (fulfillmentId) params.set("fulfillment_id", fulfillmentId)
  return `/admin/orders/${orderId}/email/draft?${params.toString()}`
}
