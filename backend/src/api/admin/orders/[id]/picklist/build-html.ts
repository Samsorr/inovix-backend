// Pure HTML builder for the printable pick list. No I/O | the route feeds it a
// plain view object. Black on white, sharp corners, A4 print CSS, Dutch copy,
// auto window.print() on load so the warehouse PC goes straight to the print
// dialog.

export type PicklistItemView = {
  product_title: string
  variant_title: string | null
  sku: string | null
  /** null when the quantity could not be resolved | rendered as "?x". */
  quantity: number | null
}

export type PicklistView = {
  display_id: number | string
  created_at: string | null
  customer_name: string
  email: string
  address_lines: string[]
  dhl_option_label: string
  service_point: string | null
  items: PicklistItemView[]
  /** The customer's checkout remark, null when they left none. */
  customer_note: string | null
}

export function escapeHtml(s: string): string {
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;")
}

// An unresolved quantity must never print as a number: "?" tells the packer to
// check the order in admin, "0x" would tell them to pack nothing.
function qty(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "?"
}

const STEPS = [
  "Betaling gecontroleerd (stap 1 staat groen in het systeem)",
  "Alle items hieronder verzameld en afgevinkt",
  "DHL-label aangemaakt in het systeem",
  "Label geprint en op het pakket geplakt, pakket gesloten",
  "In het systeem gemarkeerd als verzonden (klant krijgt de track-and-trace mail)",
]

export function buildPicklistHtml(view: PicklistView): string {
  const rows = view.items
    .map(
      (i) => `<tr>
  <td class="check"><span class="box"></span></td>
  <td>${escapeHtml(i.product_title)}</td>
  <td>${escapeHtml(i.variant_title ?? "")}</td>
  <td>${escapeHtml(i.sku ?? "")}</td>
  <td class="qty">${qty(i.quantity)}x</td>
</tr>`
    )
    .join("\n")

  const steps = STEPS.map(
    (s, n) =>
      `<li><span class="box"></span> <strong>Stap ${n + 1}.</strong> ${escapeHtml(s)}</li>`
  ).join("\n")

  const date = view.created_at
    ? new Date(view.created_at).toLocaleDateString("nl-NL", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : ""

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>Picklijst #${escapeHtml(String(view.display_id))}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; border-radius: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 24px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .muted { color: #444; }
  .grid { display: flex; gap: 24px; margin: 14px 0; }
  .grid > div { border: 1px solid #000; padding: 10px 12px; flex: 1; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #000; padding: 8px 10px; text-align: left; vertical-align: middle; }
  th { background: #eee; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
  td.qty { font-weight: bold; font-size: 15px; width: 60px; }
  td.check { width: 40px; text-align: center; }
  .box { display: inline-block; width: 18px; height: 18px; border: 2px solid #000; vertical-align: middle; }
  ol.steps { list-style: none; padding: 0; margin: 16px 0; }
  ol.steps li { margin: 8px 0; }
  .sign { margin-top: 32px; display: flex; gap: 24px; }
  .sign > div { flex: 1; border-top: 1px solid #000; padding-top: 6px; }
  .note { border: 2px solid #000; padding: 10px 12px; margin: 14px 0; }
  .note .label { text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; font-weight: bold; }
  .note .body { margin-top: 4px; white-space: pre-wrap; font-size: 14px; }
</style>
</head>
<body>
<h1>Picklijst | Bestelling #${escapeHtml(String(view.display_id))}</h1>
<div class="muted">Besteld op ${escapeHtml(date)}</div>
<div class="grid">
  <div>
    <strong>Bezorgadres</strong><br>
    ${escapeHtml(view.customer_name)}<br>
    ${view.address_lines.map(escapeHtml).join("<br>")}<br>
    ${escapeHtml(view.email)}
  </div>
  <div>
    <strong>Bezorgwijze</strong><br>
    ${escapeHtml(view.dhl_option_label)}${
      view.service_point ? `<br>${escapeHtml(view.service_point)}` : ""
    }
  </div>
</div>
${
  view.customer_note
    ? `<div class="note">
  <div class="label">Klantopmerking</div>
  <div class="body">${escapeHtml(view.customer_note)}</div>
</div>`
    : ""
}
<table>
  <thead><tr><th></th><th>Product</th><th>Sterkte / variant</th><th>SKU</th><th>Aantal</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<ol class="steps">
${steps}
</ol>
<div class="sign">
  <div>Naam inpakker</div>
  <div>Datum + handtekening</div>
</div>
<script>window.addEventListener("load", function () { window.print() })</script>
</body>
</html>`
}
