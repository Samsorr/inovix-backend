// Pure logic for the product-setup-warnings admin widget. Lives in its own
// file so we can unit-test it without booting the admin runtime / React /
// Medusa UI imports.

export type SetupCheckProduct = {
  id?: string
  shipping_profile?: { id?: string | null } | null
  variants?: Array<{
    id: string
    title?: string | null
    sku?: string | null
    manage_inventory?: boolean | null
    inventory_items?: Array<{
      inventory?: {
        id?: string | null
        location_levels?: Array<{ id?: string | null }> | null
      } | null
    }> | null
  }> | null
}

export type SetupIssue = {
  key: string
  title: string
  detail: string
  fix: string
}

export function detectSetupIssues(
  p: SetupCheckProduct | null | undefined
): SetupIssue[] {
  if (!p) return []
  const issues: SetupIssue[] = []

  if (!p.shipping_profile?.id) {
    issues.push({
      key: "shipping_profile",
      title: "Geen verzendprofiel",
      detail:
        "Zonder verzendprofiel kan een klant dit product niet afrekenen | Medusa weet dan niet welke verzendmethode er bij hoort.",
      fix: 'Open het tabblad "Verzending" hieronder en kies een verzendprofiel.',
    })
  }

  for (const v of p.variants ?? []) {
    if (v.manage_inventory !== true) continue
    const items = v.inventory_items ?? []
    const hasAnyLevel = items.some(
      (it) => (it.inventory?.location_levels ?? []).length > 0
    )
    if (!hasAnyLevel) {
      const label =
        v.title && v.title !== "Default variant"
          ? v.title
          : (v.sku ?? "(naamloze variant)")
      issues.push({
        key: `inventory:${v.id}`,
        title: `Variant "${label}" heeft geen voorraadlocatie`,
        detail:
          "manage_inventory staat aan, maar er is nog geen voorraad-regel op een locatie. Een betaling lukt wel, maar de bestelling crasht direct daarna (cart.complete 404).",
        fix: 'Open het tabblad "Inventaris" hieronder, voeg deze variant toe aan een locatie en zet een aantal (0 met allow_backorder mag ook).',
      })
    }
  }

  return issues
}
