import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Sentry } from "../lib/instrument"

type VariantRow = {
  id: string
  sku?: string | null
  manage_inventory?: boolean | null
  product?: { title?: string | null } | null
  inventory_items?: Array<{
    inventory?: {
      id?: string | null
      location_levels?: Array<{ id?: string | null }> | null
    } | null
  }> | null
}

// Surfaces variants with manage_inventory=true that have zero inventory_level
// rows | this is the silent failure that broke checkout for Retatrutide on
// 2026-05-02. The cart-complete workflow needs at least one inventory_level
// (even at qty 0) to know which location to reserve from. Without one, it
// throws "Item iitem_xxx is not stocked at location undefined" and cart
// completion 404s after the customer has paid. Daily safety net.
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
      "inventory_items.inventory.id",
      "inventory_items.inventory.location_levels.id",
    ],
  })

  const orphans = (data as VariantRow[])
    .filter((v) => v.manage_inventory === true)
    .filter((v) => {
      const items = v.inventory_items ?? []
      if (items.length === 0) return true
      return items.every(
        (it) => (it.inventory?.location_levels ?? []).length === 0
      )
    })
    .map((v) => ({
      id: v.id,
      sku: v.sku ?? "(no sku)",
      title: v.product?.title ?? "(untitled)",
    }))

  if (orphans.length === 0) {
    logger.info(
      "[inventory-level-check] all managed variants have at least one inventory_level"
    )
    return
  }

  const summary = orphans
    .map((o) => `${o.title} (sku=${o.sku})`)
    .join(", ")
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

export const config = {
  name: "check-variant-inventory-levels",
  // Every 6 hours, same cadence as the shipping-profile check.
  schedule: "0 */6 * * *",
}
