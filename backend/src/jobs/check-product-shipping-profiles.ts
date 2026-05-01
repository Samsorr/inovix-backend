import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Sentry } from "../lib/instrument"

type ProductRow = {
  id: string
  title?: string | null
  shipping_profile?: { id?: string | null } | null
}

// Surfaces products that are missing a shipping profile link. Without one,
// cart.complete() bails with "The cart items require shipping profiles that
// are not satisfied by the current shipping methods" and the customer sees
// a generic Dutch error after paying. Medusa's product editor doesn't
// auto-link a profile when a product is created, so this fires as a
// daily safety net that pings Sentry + logs a warning if any orphan slips
// through.
export default async function checkProductShippingProfiles(
  container: MedusaContainer
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (m: string) => void
    warn: (m: string) => void
  }

  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "title", "shipping_profile.id"],
  })

  const orphans = (data as ProductRow[])
    .filter((p) => !p.shipping_profile?.id)
    .map((p) => ({ id: p.id, title: p.title ?? "(untitled)" }))

  if (orphans.length === 0) {
    logger.info(
      "[shipping-profile-check] all products have a shipping profile"
    )
    return
  }

  const titles = orphans.map((o) => o.title).join(", ")
  const message = `[shipping-profile-check] ${orphans.length} product(s) without a shipping profile: ${titles}. cart.complete will fail for any cart containing these. Fix in Medusa admin > product > Shipping > assign a profile.`

  logger.warn(message)
  Sentry.captureMessage(message, {
    level: "warning",
    tags: {
      job: "check-product-shipping-profiles",
      kind: "shipping-profile-orphan",
    },
    extra: {
      orphanCount: orphans.length,
      orphans,
    },
  })
}

export const config = {
  name: "check-product-shipping-profiles",
  // Every 6 hours: catches a freshly-added unlinked product within a quarter
  // of a day, but doesn't drown Sentry if the orphan list is stable.
  schedule: "0 */6 * * *",
}
