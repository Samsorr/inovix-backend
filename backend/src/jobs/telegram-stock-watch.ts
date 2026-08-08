import type { MedusaContainer } from "@medusajs/framework/types"

import { TELEGRAM_OPS_MODULE } from "../modules/telegram-ops"
import type TelegramOpsService from "../modules/telegram-ops/service"
import { headline } from "../modules/telegram-ops/format"
import { lowStockThreshold } from "../modules/telegram-ops/commands/digest-data"
import { fetchInventoryRows } from "../modules/telegram-ops/commands/inventory-data"
import { Sentry } from "../lib/instrument"

type StockState = "low" | "oos"

// N7/N8: alert ONCE per threshold crossing, not per hourly check. State per
// inventory item lives in telegram_ops_event (key tg-stockstate-<item>,
// payload { state }); recovery above the threshold deletes the row so the
// next drop alerts again. low -> oos escalates (one more alert).
//
// UNMANAGED VARIANTS (manage_inventory=false) ARE NOT WATCHED HERE.
// This job is a threshold-crossing detector, and for an unmanaged variant
// there are no crossings to detect: Medusa creates no reservation on cart
// completion and the DHL step finds none to decrement, so stocked/reserved
// are frozen no matter how much sells. Watching them anyway produced an alert
// that was wrong in BOTH directions on the same twelve variants: it shouted
// "OUT of stock on site" for PT-141 (stocked 0) while inovix.nl was happily
// selling it with a green dot, and it could never warn about Adamax running
// down from 2 because that 2 will sit there forever.
//
// The honest message for that configuration is a different one, "this variant
// sells without any stock control", and `src/jobs/check-variant-inventory-levels.ts`
// OWNS it (Check 2, added 2026-08-07). That job is the right home and this one
// is not:
//   - it scans product_variant, so it also sees published variants that have
//     no inventory item at all; this job scans inventory_item and is blind to
//     exactly those,
//   - it is configuration drift, not a stock level: 6-hourly matches how fast
//     it can change, hourly would just repeat itself,
//   - one copy of the remediation wording, one place to keep it true.
// Its Sentry warning reaches Telegram through the ops-Sentry webhook, so the
// operator does get it in this channel. Do NOT add a second message here.
export async function runStockWatch(container: MedusaContainer): Promise<void> {
  const svc = container.resolve(TELEGRAM_OPS_MODULE) as TelegramOpsService
  if (!svc.isConfigured()) return
  const threshold = lowStockThreshold()
  const logger = container.resolve("logger") as { info: (m: string) => void }

  // Human product names (product + variant), not the packaging title.
  const rows = await fetchInventoryRows(container)
  const unwatched: string[] = []

  for (const item of rows) {
    const { available, reserved, name } = item
    const key = `tg-stockstate-${item.id}`
    const stateRow = await svc.findEvent(key)

    // `false` only. `null` (no variant link, or the lookup failed) keeps the
    // old behaviour, so a cosmetic lookup failure can never silence the
    // whole channel.
    if (item.managed === false) {
      unwatched.push(name)
      // Drop any crossing state left over from before the flag was switched
      // off, so switching it back on re-arms from a clean slate.
      if (stateRow) await svc.releaseAction(key)
      continue
    }

    const current: StockState | null = available <= 0 ? "oos" : available <= threshold ? "low" : null
    const stored = (stateRow?.payload as { state?: StockState } | null)?.state ?? null

    if (!current) {
      if (stateRow) await svc.releaseAction(key) // recovered: re-arm
      continue
    }
    if (stored === current || (stored === "oos" && current === "low")) continue // no worsening

    const text = current === "oos"
      ? headline("🔴", `OUT of stock on site: ${name}`)
      : [
          headline("⚠️", `Low stock: ${name}`),
          `${available} left (${reserved} reserved, threshold ${threshold})`,
        ].join("\n")
    await svc.sendToAll(text, {
      reply_markup: { inline_keyboard: [[
        // Button labels are plain text, NOT HTML: escaping here would render a
        // literal "A&amp;B", and slicing after escaping could cut an entity in
        // half. Slice the raw name.
        { text: `➕ Restock ${name.slice(0, 20)}`, callback_data: `rsk:${item.id}` },
        { text: "📦 Stock", callback_data: "stk" },
      ]] },
    })
    await svc.touchEvent(key, "stock_state", { sent_at: new Date(), payload: { state: current } })
  }

  if (unwatched.length > 0) {
    // Log only. check-variant-inventory-levels owns the operator-facing alert.
    logger.info(
      `telegram-stock-watch: ${unwatched.length} item(s) skipped, the variant sells without stock control (manage_inventory=false, numbers cannot move): ${unwatched.join(", ")}`
    )
  }
}

export default async function telegramStockWatch(container: MedusaContainer): Promise<void> {
  try {
    await runStockWatch(container)
  } catch (e) {
    const logger = container.resolve("logger") as { error: (m: string) => void }
    logger.error(`telegram-stock-watch: ${(e as Error).message}`)
    Sentry.captureException(e, { tags: { job: "telegram-stock-watch" } })
  }
}

export const config = {
  name: "telegram-stock-watch",
  // hourly, offset from the other telegram jobs
  schedule: "0 * * * *",
}
