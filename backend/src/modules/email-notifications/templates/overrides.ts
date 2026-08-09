/**
 * One rule for every editable string in an email template: an override with
 * real content wins, anything else falls back to the localized default.
 *
 * The empty/whitespace fallback is load-bearing. It is what makes "clear the
 * field to restore the standard text" work in the admin composer, and it is
 * what stops a blank paragraph reaching a customer.
 */
export function resolveText(
  overrides: Record<string, string> | undefined,
  key: string,
  fallback: string
): string {
  const value = overrides?.[key]
  if (typeof value !== 'string') return fallback
  return value.trim().length > 0 ? value : fallback
}
