import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Sentry } from "../lib/instrument"

type VariantRow = {
  id: string
  sku?: string | null
  manage_inventory?: boolean | null
  product?: { title?: string | null; status?: string | null } | null
  inventory_items?: Array<{
    inventory?: {
      id?: string | null
      location_levels?: Array<{ id?: string | null }> | null
    } | null
  }> | null
}

// Two checks, both about variants whose stock configuration lets a paid order
// go wrong:
//
//   1. manage_inventory=true with zero inventory_level rows | the silent
//      failure that broke checkout for Retatrutide on 2026-05-02. The
//      cart-complete workflow needs at least one inventory_level (even at qty 0)
//      to know which location to reserve from. Without one, it throws "Item
//      iitem_xxx is not stocked at location undefined" and cart completion 404s
//      after the customer has paid.
//
//   2. manage_inventory=false on a PUBLISHED variant | the opposite failure.
//      Medusa drops unmanaged variants from every stock gate it has
//      (prepare-confirm-inventory-input skips them, reserveInventoryStep gets an
//      empty list, the DHL step finds no reservation to decrement), so the shop
//      accepts any quantity for a product with nothing on the shelf and no
//      number ever moves. Check 1 filters to managed variants, so for three
//      weeks this configuration had zero automated coverage | that is exactly
//      why it is checked here too.
//
// Runs every 6 hours.
export default async function checkVariantInventoryLevels(
  container: MedusaContainer
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (m: string) => void
    warn: (m: string) => void
  }

  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "manage_inventory",
      "product.title",
      "product.status",
      "inventory_items.inventory.id",
      "inventory_items.inventory.location_levels.id",
    ],
  })

  const rows = data as VariantRow[]
  const label = (v: VariantRow) => ({
    id: v.id,
    sku: v.sku ?? "(no sku)",
    title: v.product?.title ?? "(untitled)",
  })

  // --- Check 1: managed, but no inventory_level to reserve from -------------
  const orphans = rows
    .filter((v) => v.manage_inventory === true)
    .filter((v) => {
      const items = v.inventory_items ?? []
      if (items.length === 0) return true
      return items.every(
        (it) => (it.inventory?.location_levels ?? []).length === 0
      )
    })
    .map(label)

  if (orphans.length === 0) {
    logger.info(
      "[inventory-level-check] all managed variants have at least one inventory_level"
    )
  } else {
    const summary = orphans.map((o) => `${o.title} (sku=${o.sku})`).join(", ")
    const message = `[inventory-level-check] ${orphans.length} managed variant(s) without inventory_level rows: ${summary}. cart.complete will 404 for any cart containing these. Fix in admin > product > variant > Inventory tab > set qty (0 + allow_backorder is fine).`

    logger.warn(message)
    Sentry.captureMessage(message, {
      level: "warning",
      tags: {
        job: "check-variant-inventory-levels",
        kind: "inventory-level-orphan",
      },
      extra: {
        orphanCount: orphans.length,
        orphans,
      },
    })
  }

  // --- Check 2: published, but stock control is switched off ----------------
  // Deliberately not filtered on price: a variant without a price is already
  // flagged by the admin product widget, and reading prices here would mean
  // traversing a cross-module link from query.graph, which this codebase does
  // not do. Deliberately restricted to published products: an unmanaged variant
  // on a draft/proposed product is not customer facing yet.
  const unmanaged = rows
    .filter((v) => v.manage_inventory !== true)
    .filter((v) => v.product?.status === "published")
    .map(label)

  if (unmanaged.length === 0) {
    logger.info(
      "[inventory-level-check] all published variants have manage_inventory=true"
    )
    return
  }

  const unmanagedSummary = unmanaged
    .map((o) => `${o.title} (sku=${o.sku})`)
    .join(", ")
  const unmanagedMessage = `[inventory-level-check] ${unmanaged.length} published variant(s) with manage_inventory=false: ${unmanagedSummary}. These sell WITHOUT any stock check | the shop accepts any quantity, no reservation is made, and stock never decrements, so they can be oversold without anything noticing. Fix in admin > product > variant > Inventory tab: set the real counted quantity first, then switch stock management on.`

  logger.warn(unmanagedMessage)
  Sentry.captureMessage(unmanagedMessage, {
    level: "warning",
    tags: {
      job: "check-variant-inventory-levels",
      kind: "unmanaged-published-variant",
    },
    extra: {
      unmanagedCount: unmanaged.length,
      unmanaged,
    },
  })
}

export const config = {
  name: "check-variant-inventory-levels",
  // Every 6 hours, same cadence as the shipping-profile check.
  schedule: "0 */6 * * *",
}
