// Resolving a line-item quantity read through a direct query.graph.
//
// Two live-prod shapes make a single-field read unsafe (commit bf77956):
//  1. items.quantity comes back `undefined` | the real value sits on
//     items.detail.
//  2. bigNumber columns surface as raw { value, precision } objects instead of
//     numbers, so Number() on them is NaN.
// Every query that needs quantities must therefore request ITEM_QUANTITY_FIELDS
// (all four shapes) and resolve them through itemQuantity below.
//
// Strict on purpose, unlike toAmount (which turns anything unparseable into 0):
// an unresolvable quantity returns null so the caller can show a visible "?" or
// fail loudly, instead of silently telling a packer to pick nothing.

export const ITEM_QUANTITY_FIELDS = [
  "items.quantity",
  "items.raw_quantity",
  "items.detail.quantity",
  "items.detail.raw_quantity",
]

export type ItemQuantityShape = {
  quantity?: unknown
  raw_quantity?: unknown
  detail?: { quantity?: unknown; raw_quantity?: unknown } | null
}

export function asQty(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === "object") return asQty((v as { value?: unknown }).value)
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function firstQty(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = asQty(v)
    if (n != null) return n
  }
  return null
}

// null when no shape carries a usable number (including a null line item,
// which live relation arrays do contain | see commit 9d7e9fa).
export function itemQuantity(item: ItemQuantityShape | null | undefined): number | null {
  if (!item) return null
  return firstQty(
    item.quantity,
    item.raw_quantity,
    item.detail?.quantity,
    item.detail?.raw_quantity
  )
}
