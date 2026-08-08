// Turns a DHL label failure into something the operator can act on.
//
// Before this existed, every non-MedusaError failure reached the admin as the
// English sentence "DHL label creation failed": an expired DHL key, a rejected
// postcode, a DHL outage, a network timeout, a product without a weight and a
// deleted box preset were all the same red toast on an otherwise Dutch screen.
// The route computed the real cause and threw it away.
//
// Pure string mapping, no I/O, so it is unit-testable and usable from the
// route without touching the workflow.

export type LabelFailureCode =
  | "dhl_auth"
  | "dhl_rejected"
  | "dhl_unavailable"
  | "no_connection"
  | "missing_weight"
  | "no_box_presets"
  | "no_shipping_method"
  | "no_items"
  | "order_not_shippable"
  | "payment"
  | "unknown"

export type LabelFailureView = {
  code: LabelFailureCode
  /** Dutch: what went wrong and what the operator should do next. */
  message: string
  /**
   * The technical message behind it, sanitised, for the "meer details"
   * disclosure. Null when the Dutch message already says everything.
   */
  details: string | null
}

const MAX_DETAIL_LENGTH = 500

// Keys whose VALUE must never be echoed back into the admin UI (or into a
// screenshot the operator pastes into a chat). The DHL client only ever puts
// origin + pathname in its messages, but an unexpected error can come from
// anywhere, so this is deliberately about the shape, not the source.
const SECRET_KEY = /\b(authorization|bearer|token|api[_-]?key|apikey|secret|password|passwd|pwd|client[_-]?secret)\b/gi

/**
 * Makes a raw error message safe to render in the admin.
 *
 * Suppressing it entirely would be worse than useless (that is the bug being
 * fixed), so the value is kept and only the parts that could carry a
 * credential are removed: anything following a secret-looking key, JWTs, long
 * opaque tokens, and query strings.
 */
export function sanitizeErrorDetail(raw: unknown): string | null {
  if (raw == null) return null
  const text = String(raw).replace(/\s+/g, " ").trim()
  if (!text) return null

  const redacted = text
    // key=value / key: value / "key": "value"
    .replace(
      new RegExp(`(${SECRET_KEY.source})(["']?\\s*[:=]\\s*["']?)([^\\s"',;)]+)`, "gi"),
      "$1$2[verwijderd]"
    )
    // "Bearer eyJ..." style headers
    .replace(/\bbearer\s+\S+/gi, "Bearer [verwijderd]")
    // JWTs anywhere
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, "[verwijderd]")
    // Query strings (the DHL client strips them, other libraries do not)
    .replace(/\?[^\s]*/g, "?[verwijderd]")
    // Long opaque blobs that are almost certainly credentials
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[verwijderd]")

  return redacted.length > MAX_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}...`
    : redacted
}

// A message that is already Dutch and already names the exact problem is
// better than anything this file could write, so it is passed through.
function passthrough(code: LabelFailureCode, message: string): LabelFailureView {
  return { code, message, details: null }
}

/**
 * Maps the raw failure message from createDhlLabelForOrder (a MedusaError
 * message on `invalid`, any thrown Error's message on `error`) to a Dutch
 * operator message plus a sanitised technical detail.
 */
export function describeLabelFailure(raw: string | null | undefined): LabelFailureView {
  const text = (raw ?? "").trim()
  const details = sanitizeErrorDetail(text)
  const lower = text.toLowerCase()

  // ── Causes the operator can fix on their own ──────────────────────────────

  // Already Dutch and names the product: "Product "BPC-157" heeft nog geen
  // gewicht. Stel een gewicht (in gram) in op dit product ..."
  if (lower.includes("heeft nog geen gewicht")) {
    return passthrough("missing_weight", text)
  }
  if (lower.includes("missing a product weight")) {
    return {
      code: "missing_weight",
      message:
        "Een product in deze bestelling heeft geen gewicht. Stel het gewicht (in gram) in op het product en probeer het opnieuw.",
      details,
    }
  }
  if (lower.includes("box preset") || lower.includes("box presets")) {
    return {
      code: "no_box_presets",
      message:
        "Er zijn geen doosformaten ingesteld, daardoor kan er geen label worden gemaakt. Voeg er een toe bij Instellingen > DHL doosformaten.",
      details,
    }
  }
  if (lower.includes("no dhl parcel shipping method")) {
    return {
      code: "no_shipping_method",
      message:
        "Deze bestelling heeft geen DHL-verzendmethode, daarom kan er geen DHL-label worden gemaakt. Maak de verzending handmatig aan.",
      details,
    }
  }
  if (lower.includes("order has no items")) {
    return {
      code: "no_items",
      message: "Deze bestelling heeft geen regels, er valt niets te verzenden.",
      details,
    }
  }
  if (/^order is (canceled|cancelled|refunded)/i.test(text)) {
    const status = /^order is (\w+)/i.exec(text)?.[1] ?? "onbekend"
    return {
      code: "order_not_shippable",
      message: `Deze bestelling heeft status "${status}"; er kan geen DHL-label worden gemaakt.`,
      details,
    }
  }
  // The payment gate composes its own Dutch sentence, ending in an
  // instruction ("Controleer de betaling ... of gebruik de override").
  if (lower.includes("betaling")) {
    return passthrough("payment", text)
  }

  // ── DHL-side causes ───────────────────────────────────────────────────────

  // Check auth before the generic status branch: the 401 message can also
  // contain "after re-auth".
  if (/\b401\b/.test(text) || lower.includes("authentication") || lower.includes("unauthorized")) {
    return {
      code: "dhl_auth",
      message:
        "De koppeling met DHL werd geweigerd (inloggegevens verlopen of ongeldig). Er is geen label gekocht. Meld dit bij de beheerder; opnieuw proberen helpt niet.",
      details,
    }
  }
  if (/\b5\d\d\b/.test(text) || lower.includes("after retry")) {
    return {
      code: "dhl_unavailable",
      message:
        "DHL is op dit moment niet bereikbaar. Probeer het over een paar minuten opnieuw; er wordt nooit twee keer een label gekocht.",
      details,
    }
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("network")
  ) {
    return {
      code: "no_connection",
      message:
        "Geen verbinding met DHL. Controleer de internetverbinding en probeer het opnieuw; er wordt nooit twee keer een label gekocht.",
      details,
    }
  }
  if (/\b(400|403|404|409|422)\b/.test(text) || lower.includes("dhl parcel")) {
    return {
      code: "dhl_rejected",
      message:
        "DHL heeft de labelaanvraag geweigerd. Controleer het bezorgadres, de postcode en het land van deze bestelling. De melding van DHL staat hieronder.",
      details,
    }
  }

  return {
    code: "unknown",
    message:
      "Het DHL-label kon niet worden aangemaakt. De technische melding staat hieronder; probeer het opnieuw of stuur deze melding door naar de beheerder.",
    details,
  }
}
