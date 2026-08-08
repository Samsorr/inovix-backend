import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"

import { resendOrderConfirmation } from "../../../../../lib/order-notifications"

// POST /admin/orders/:id/resend-confirmation
//
// This used to re-emit `order.placed`, which the subscriber dedups on
// `order-confirmed-<orderId>` | so the route answered `{ ok: true }` while the
// notification module silently skipped the send and the customer got nothing.
// It now replays the stored confirmation under a unique idempotency key, and
// only falls back to emitting the event when no confirmation exists yet.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id
  if (!orderId) {
    res.status(400).json({ error: "order id is required" })
    return
  }

  const logger = req.scope.resolve("logger") as Logger

  try {
    const result = await resendOrderConfirmation(req.scope, orderId)

    if (!result.ok) {
      logger.error(
        `admin.resend-confirmation failed for ${orderId}: ${result.message ?? "unknown"}`
      )
      res.status(500).json({ error: "Failed to trigger resend" })
      return
    }

    if (result.resent) {
      logger.info(
        `admin.resend-confirmation: re-sent the order confirmation for ${orderId} to ${result.to}`
      )
    } else {
      logger.info(
        `admin.resend-confirmation: no confirmation on record for ${orderId}; re-emitted order.placed`
      )
    }

    res.status(200).json({
      ok: true,
      orderId,
      sent: result.resent === true,
      emitted: result.emitted === true,
    })
  } catch (err) {
    logger.error(
      `admin.resend-confirmation failed for ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ error: "Failed to trigger resend" })
  }
}
