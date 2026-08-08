import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { MedusaContainer } from '@medusajs/framework/types'

// Inventory rows with HUMAN names. inventory_item.title on live data is the
// packaging ("Vial", "Bottle"), not the product; the real name lives on the
// linked variant + product. The variant->inventory link is resolvable via
// query.graph on product_variant (same pattern as
// src/jobs/check-variant-inventory-levels.ts, verified in prod).

export type InventoryRow = {
  id: string
  name: string
  stocked: number
  reserved: number
  available: number
  locationId: string | null
  /**
   * The linked variant's manage_inventory flag.
   *
   * `false` means Medusa drops this variant from every stock gate it has, so
   * these numbers NEVER move no matter what sells: no reservation on cart
   * completion, no decrement on fulfillment. Any consumer reasoning about
   * movement (thresholds, out-of-stock) must treat that as "not measurable
   * here", not as a stock level.
   *
   * `null` means unknown: no variant link (13 legacy inventory items have
   * none) or the variant lookup failed. Deliberately distinct from `false` so
   * a failing lookup degrades to the old, noisier behaviour instead of
   * silencing every alert at once.
   */
  managed: boolean | null
}

type VariantRow = {
  id: string
  title?: string | null
  sku?: string | null
  manage_inventory?: boolean | null
  product?: { title?: string | null } | null
  // The link exposes the related inventory item as `inventory`; its id is
  // the ONLY verified graph path (inventory_items.inventory.id, same as
  // src/jobs/check-variant-inventory-levels.ts). A flat
  // `inventory_items.inventory_item_id` resolves to undefined SILENTLY
  // (live-verified 2026-07-17: it left this map empty and every stock
  // surface fell back to the packaging title).
  inventory_items?: Array<{ inventory?: { id?: string | null } | null } | null> | null
}

// "BPC-157 10mg" from product + variant title; a lone default variant adds
// no information, so it is dropped. Falls back to sku, then the raw
// inventory title.
export function inventoryDisplayName(v: VariantRow | undefined, fallback: string): string {
  if (!v) return fallback
  const product = (v.product?.title ?? '').trim()
  const variantTitle = (v.title ?? '').trim()
  const meaningfulVariant = variantTitle && !/^default variant$/i.test(variantTitle) ? variantTitle : ''
  const combined = `${product} ${meaningfulVariant}`.trim()
  return combined || (v.sku ?? '').trim() || fallback
}

async function variantByInventoryItem(container: MedusaContainer): Promise<Map<string, VariantRow>> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const map = new Map<string, VariantRow>()
  try {
    const { data } = await query.graph({
      entity: 'product_variant',
      fields: ['id', 'title', 'sku', 'manage_inventory', 'product.title', 'inventory_items.inventory.id'],
    })
    for (const v of (data ?? []) as Array<VariantRow | null>) {
      if (!v) continue
      for (const link of v.inventory_items ?? []) {
        const invId = link?.inventory?.id
        if (invId) map.set(String(invId), v)
      }
    }
  } catch {
    // Naming is cosmetic: a failing variant lookup must never break a stock
    // surface. Callers fall back to the raw inventory titles.
  }
  return map
}

export async function fetchInventoryRows(container: MedusaContainer): Promise<InventoryRow[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const [{ data }, names] = await Promise.all([
    query.graph({
      entity: 'inventory_item',
      fields: ['id', 'sku', 'title', 'location_levels.location_id', 'location_levels.stocked_quantity', 'location_levels.reserved_quantity'],
    }),
    variantByInventoryItem(container),
  ])
  return ((data ?? []) as Array<{ id: string; sku?: string | null; title?: string | null; location_levels?: Array<{ location_id?: string; stocked_quantity?: number | string; reserved_quantity?: number | string }> } | null>)
    .filter(Boolean)
    .map((i) => {
      const stocked = (i!.location_levels ?? []).reduce((n, l) => n + Number(l?.stocked_quantity ?? 0), 0)
      const reserved = (i!.location_levels ?? []).reduce((n, l) => n + Number(l?.reserved_quantity ?? 0), 0)
      // SKU before title: live titles are the packaging ("10mg Vial") while
      // skus name the product ("KPV-Vial-10MG"). Matters for the 13 legacy
      // inventory items that have no variant link at all.
      const fallback = String(i!.sku || i!.title || i!.id)
      const variant = names.get(String(i!.id))
      return {
        id: String(i!.id),
        name: inventoryDisplayName(variant, fallback),
        stocked,
        reserved,
        available: stocked - reserved,
        locationId: (i!.location_levels ?? [])[0]?.location_id ?? null,
        // Only an EXPLICIT boolean counts. An unknown field name returns
        // undefined silently through query.graph, and treating that as false
        // would silence every stock alert at once.
        managed: typeof variant?.manage_inventory === 'boolean' ? variant.manage_inventory : null,
      }
    })
}

// Single item by inventory_item id, same naming.
export async function fetchInventoryRow(container: MedusaContainer, invItemId: string): Promise<InventoryRow | null> {
  const rows = await fetchInventoryRows(container)
  return rows.find((r) => r.id === invItemId) ?? null
}
