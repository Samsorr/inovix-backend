import { editableFieldsFor } from '../modules/email-notifications/templates/editable-fields'

export type ValidateResult = {
  ok: boolean
  /** Present when ok: the cleaned overrides. An empty object means "not edited". */
  value?: Record<string, string>
  /** Present when not ok: Dutch messages for the operator. */
  errors?: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Gatekeeper between the admin form and a customer's inbox.
 *
 * Unknown keys are REJECTED rather than dropped: a typo that is silently
 * ignored looks to the operator like an edit that was sent, and they would
 * only find out from the customer.
 */
export function validateOverrides(template: string, input: unknown): ValidateResult {
  const fields = editableFieldsFor(template)
  if (fields.length === 0) {
    return { ok: false, errors: [`Sjabloon "${template}" kan niet bewerkt worden.`] }
  }

  if (input == null) return { ok: true, value: {} }
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['Aangepaste teksten moeten een plat object zijn.'] }
  }

  const byKey = new Map(fields.map((f) => [f.key, f]))
  const errors: string[] = []
  const value: Record<string, string> = {}

  for (const [key, raw] of Object.entries(input)) {
    const field = byKey.get(key)
    if (!field) {
      errors.push(`Onbekend veld "${key}" voor dit sjabloon.`)
      continue
    }
    if (typeof raw !== 'string') {
      errors.push(`Veld "${field.label}" moet tekst zijn.`)
      continue
    }
    if (raw.trim().length === 0) {
      // Deliberately dropped: clearing a field restores de standaardtekst.
      continue
    }
    if (raw.length > field.maxLength) {
      errors.push(`Veld "${field.label}" is te lang (max ${field.maxLength} tekens).`)
      continue
    }
    if (field.type === 'url' && !isHttpUrl(raw)) {
      errors.push(`Veld "${field.label}" moet een volledige http(s)-link zijn.`)
      continue
    }
    value[key] = raw
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}
