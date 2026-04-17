import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import type {
  IEventBusModuleService,
  Logger,
} from "@medusajs/framework/types"

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id
  if (!orderId) {
    res.status(400).json({ error: "order id is required" })
    return
  }

  const eventBus = req.scope.resolve(
    Modules.EVENT_BUS
  ) as IEventBusModuleService
  const logger = req.scope.resolve("logger") as Logger

  try {
    await eventBus.emit({
      name: "order.placed",
      data: { id: orderId },
    })

    logger.info(
      `admin.resend-confirmation: re-emitted order.placed for ${orderId}`
    )
    res.status(200).json({ ok: true, orderId })
  } catch (err) {
    logger.error(
      `admin.resend-confirmation failed for ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ error: "Failed to trigger resend" })
  }
}
