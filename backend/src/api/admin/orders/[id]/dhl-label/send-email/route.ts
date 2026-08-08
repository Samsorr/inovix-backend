import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { MedusaError } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"

import { markDhlOrderShipped } from "../../../../../../lib/mark-dhl-shipped"

// POST /admin/orders/:id/dhl-label/send-email
// Marks the order's DHL fulfillment as shipped and sends the tracking email.
// The heavy lifting lives in lib/mark-dhl-shipped so the auto-mark-shipped
// job runs the identical flow; the email is idempotency-keyed so the two
// paths never double-send.
//
// Body `{ resend: true }` is the operator's deliberate "stuur de verzendmail
// opnieuw" action: it uses a unique idempotency key so the customer really
// gets a second copy. Without it this route was a silent no-op on an
// already-mailed order while still answering 200. The response now reports
// what actually happened so the admin toast cannot lie.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id
  const logger = req.scope.resolve("logger") as Logger
  const body = (req.body ?? {}) as { resend?: boolean }

  try {
    const result = await markDhlOrderShipped(req.scope, orderId, {
      resend: body.resend === true,
    })

    if (result.ok) {
      if (result.email_sent) {
        logger.info(
          `admin.dhl-label.send-email: shipped email sent for fulfillment ${result.fulfillment_id} on order ${orderId}`
        )
      } else {
        logger.warn(
          `admin.dhl-label.send-email: NO email sent for fulfillment ${result.fulfillment_id} on order ${orderId} (${result.email_reason ?? "unknown"})`
        )
      }
      res.status(200).json({
        sent: result.email_sent === true,
        already_shipped: result.already_shipped === true,
        ...(result.email_reason ? { reason: result.email_reason } : {}),
      })
      return
    }

    if (result.reason === "order_not_found") {
      res.status(404).json({ message: `Order ${orderId} not found` })
      return
    }
    res.status(400).json({
      message: "Geen DHL-label met tracking gevonden voor deze bestelling",
    })
  } catch (err: any) {
    if (MedusaError.isMedusaError(err)) {
      const status =
        err.type === MedusaError.Types.NOT_FOUND ? 404
        : err.type === MedusaError.Types.NOT_ALLOWED ? 400
        : err.type === MedusaError.Types.INVALID_DATA ? 400
        : 500

      logger.warn(
        `admin.dhl-label.send-email: validation error for order ${orderId}: [${err.type}] ${err.message}`
      )
      res.status(status).json({ message: err.message })
      return
    }

    logger.error(
      `admin.dhl-label.send-email: unexpected error for order ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ message: "Failed to send shipped email" })
  }
}
