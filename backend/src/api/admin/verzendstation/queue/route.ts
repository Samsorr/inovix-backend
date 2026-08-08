import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  buildVerzendstationQueues,
  QUEUE_ORDER_FIELDS,
  type QueueOrderRow,
} from "../../../../lib/verzendstation-queues"

// GET /admin/verzendstation/queue | the warehouse work queues. Looks at the
// most recent 200 orders; anything older that still needs action is caught by
// the daily unshipped-orders alert (and 200 open orders would mean far bigger
// problems than a queue page).
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    warn: (m: string) => void
  }
  const { data } = await query.graph({
    entity: "order",
    fields: QUEUE_ORDER_FIELDS,
    pagination: { take: 200, skip: 0, order: { created_at: "DESC" } },
  })
  res.status(200).json(
    buildVerzendstationQueues((data ?? []) as QueueOrderRow[], {
      // A malformed order is dropped from the queue instead of 500ing the page
      // for every other order; it must still be identifiable in the logs.
      onSkip: (orderId, err) =>
        logger.warn(
          `[verzendstation-queue] skipped order ${orderId}: ${(err as Error)?.message}`
        ),
    })
  )
}
