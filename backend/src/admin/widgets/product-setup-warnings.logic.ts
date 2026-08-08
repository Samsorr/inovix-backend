// Pure logic for the product-setup-warnings admin widget. Lives in its own
// file so we can unit-test it without booting the admin runtime / React /
// Medusa UI imports.

export type SetupCheckProduct = {
  id?: string
  // "published" = live on the website. Only then does a variant without stock
  // control actually sell.
  status?: string | null
  // product-level weight (grams). The DHL label flow reads this (via
  // item.variant.product.weight); without it a paid order cannot be shipped.
  weight?: number | null
  thumbnail?: string | null
  images?: Array<{ id?: string | null }> | null
  shipping_profile?: { id?: string | null } | null
  variants?: Array<{
    id: string
    title?: string | null
    sku?: string | null
    manage_inventory?: boolean | null
    prices?: Array<{ amount?: number | null }> | null
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

function variantLabel(v: { title?: string | null; sku?: string | null }): string {
  return v.title && v.title !== "Default variant"
    ? v.title
    : (v.sku ?? "(naamloze variant)")
}

export function detectSetupIssues(
  p: SetupCheckProduct | null | undefined
): SetupIssue[] {
  if (!p) return []
  const issues: SetupIssue[] = []

  // Weight | required for the DHL label.
  if (p.weight == null) {
    issues.push({
      key: "weight",
      title: "Geen gewicht",
      detail:
        "Zonder gewicht kan er geen DHL-verzendlabel worden aangemaakt. De klant kan wel betalen, maar de bestelling kan daarna niet verzonden worden.",
      fix: 'Vul het gewicht (in gram) in op dit product, in de sectie "Organiseren" / productgegevens.',
    })
  }

  // Image | otherwise the product looks empty on the site.
  const hasImage = Boolean(p.thumbnail) || (p.images?.length ?? 0) > 0
  if (!hasImage) {
    issues.push({
      key: "image",
      title: "Geen afbeelding",
      detail:
        "Dit product heeft nog geen foto. Op de website oogt het dan leeg en onbetrouwbaar.",
      fix: 'Voeg minstens één afbeelding toe in de sectie "Media".',
    })
  }

  // Shipping profile | needed to check out at all.
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
    // Price | only flag when we definitively have an empty price list, so a
    // field that simply wasn't loaded never raises a false alarm.
    if (Array.isArray(v.prices)) {
      const hasPrice = v.prices.some((pr) => typeof pr.amount === "number")
      if (!hasPrice) {
        issues.push({
          key: `price:${v.id}`,
          title: `Variant "${variantLabel(v)}" heeft geen prijs`,
          detail:
            "Een variant zonder prijs kan niet worden afgerekend.",
          fix: 'Open het tabblad "Prijzen" hieronder en stel een prijs (EUR) in.',
        })
      }
    }

    // No stock control at all. Medusa drops unmanaged variants from every stock
    // gate (add-to-cart check, reservation at cart.complete, the DHL decrement),
    // so on a live product this sells unlimited quantities off a shelf that may
    // be empty and the number never moves. Only flag it once the product is
    // published; on a concept product it is not customer facing yet.
    if (v.manage_inventory !== true) {
      if (p.status === "published") {
        issues.push({
          key: `unmanaged:${v.id}`,
          title: `Variant "${variantLabel(v)}" verkoopt zonder voorraadcontrole`,
          detail:
            'Voorraadbeheer staat uit voor deze variant. De site toont hem altijd als "Op voorraad", een klant kan elk aantal bestellen, er wordt niets gereserveerd en bij verzending gaat de voorraad niet omlaag. Je kunt dus meer verkopen dan er ligt zonder dat iets waarschuwt.',
          fix: 'Tel eerst wat er fysiek ligt. Open dan het tabblad "Inventaris" hieronder, zet dat aantal op de locatie en schakel daarna pas voorraadbeheer in. In die volgorde: eerder inschakelen zonder voorraadregel laat een al betaalde bestelling mislukken.',
        })
      }
      continue
    }

    // Inventory location | only relevant when stock is managed.
    const items = v.inventory_items ?? []
    const hasAnyLevel = items.some(
      (it) => (it.inventory?.location_levels ?? []).length > 0
    )
    if (!hasAnyLevel) {
      issues.push({
        key: `inventory:${v.id}`,
        title: `Variant "${variantLabel(v)}" heeft geen voorraadlocatie`,
        detail:
          "manage_inventory staat aan, maar er is nog geen voorraad-regel op een locatie. Een betaling lukt wel, maar de bestelling crasht direct daarna (cart.complete 404).",
        fix: 'Open het tabblad "Inventaris" hieronder, voeg deze variant toe aan een locatie en zet een aantal (0 met allow_backorder mag ook).',
      })
    }
  }

  return issues
}
