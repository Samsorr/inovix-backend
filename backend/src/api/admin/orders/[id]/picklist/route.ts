import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { buildPicklistHtml, type PicklistView } from "./build-html"
import { customerNoteFromOrder } from "../../../../../admin/widgets/customer-note.logic"
// Direct query.graph serves quantities in several shapes: undefined on
// items.quantity with the real value on items.detail, and bigNumber columns as
// raw {value, precision} objects. Request all four (ITEM_QUANTITY_FIELDS) and
// resolve with the shared helper | a single-field read prints "0x" on the paper
// the packer fills the box from.
import {
  itemQuantity,
  ITEM_QUANTITY_FIELDS,
} from "../../../../../lib/item-quantity"

// GET /admin/orders/:id/picklist | printable A4 pick list. Behind the standard
// admin session auth (all /admin routes are). Opened in a new tab by the
// fulfillment checklist widget's "Print picklijst" button.
//
// query.graph field rules: trailing-star nested paths only, and NEVER
// shipping_methods.shipping_option (unresolvable cross-module expansion, 500s).
// The DHL option comes from shipping_methods.data, same as the dhl-label route.
const ORDER_FIELDS = [
  "id",
  "display_id",
  "created_at",
  "email",
  "metadata",
  "shipping_address.*",
  "items.id",
  ...ITEM_QUANTITY_FIELDS,
  "items.title",
  "items.product_title",
  "items.variant_title",
  "items.variant_sku",
  "shipping_methods.id",
  "shipping_methods.data",
]

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    filters: { id: req.params.id },
    fields: ORDER_FIELDS,
  })

  const order = (data?.[0] ?? null) as any
  if (!order) {
    res.status(404).send("Bestelling niet gevonden")
    return
  }

  const a = order.shipping_address ?? {}
  const dhlData =
    ((order.shipping_methods ?? []) as any[])
      .map((m) => m.data ?? {})
      .find((d) => typeof d.dhl_option === "string") ?? {}
  const isPs = dhlData.dhl_option === "PS"

  const view: PicklistView = {
    display_id: order.display_id,
    created_at: order.created_at ? String(order.created_at) : null,
    customer_name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
    email: order.email ?? "",
    address_lines: [
      a.company,
      a.address_1,
      a.address_2,
      `${a.postal_code ?? ""} ${a.city ?? ""}`.trim(),
      (a.country_code ?? "").toUpperCase(),
    ].filter((l): l is string => Boolean(l && String(l).trim())),
    dhl_option_label: isPs ? "DHL Servicepunt" : "DHL Thuisbezorgd",
    service_point: isPs
      ? [dhlData.service_point_name, dhlData.service_point_address]
          .filter(Boolean)
          .join(" | ") || null
      : null,
    // Live relation arrays can contain null elements (commit 9d7e9fa); one
    // would otherwise 500 the print instead of printing the other lines.
    items: ((order.items ?? []) as any[]).filter(Boolean).map((i) => ({
      product_title: i.product_title ?? i.title ?? "Onbekend product",
      variant_title: i.variant_title ?? null,
      sku: i.variant_sku ?? null,
      // null (not 0) when no shape resolves: build-html then prints "?x", so a
      // data quirk reads as "check this order", never as "pick nothing".
      quantity: itemQuantity(i),
    })),
    customer_note: customerNoteFromOrder(order),
  }

  res.setHeader("content-type", "text/html; charset=utf-8")
  res.status(200).send(buildPicklistHtml(view))
}
