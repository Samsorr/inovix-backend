import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const PROVIDER_ID = "pp_multisafepay_multisafepay"

type RequestBody = {
  cart_id?: string
  transaction_id?: string | number
  order_id?: string
}

type SessionDataShape = {
  mspOrderId?: string
  paymentUrl?: string
  transactionId?: string
  amount?: number
  currency?: string
}

type PaymentSessionRow = {
  id: string
  provider_id: string
  data: SessionDataShape
  amount: number
  currency_code: string
}

// The storefront calls this endpoint from /checkout/multisafepay-return
// after MultiSafepay redirects the customer back. We attach the MSP
// transaction_id (and verify the round-trip order_id) to the Medusa
// payment session so the subsequent cart.complete() can authorize.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { cart_id, transaction_id, order_id } = (req.body ?? {}) as RequestBody

  if (!cart_id || !transaction_id) {
    res
      .status(400)
      .json({ error: "cart_id and transaction_id are required" })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const paymentModule = req.scope.resolve(Modules.PAYMENT)
  const logger = req.scope.resolve("logger") as {
    error: (message: string) => void
  }

  try {
    const { data } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "payment_collection.id",
        "payment_collection.payment_sessions.id",
        "payment_collection.payment_sessions.provider_id",
        "payment_collection.payment_sessions.data",
        "payment_collection.payment_sessions.amount",
        "payment_collection.payment_sessions.currency_code",
      ],
      filters: { id: cart_id },
    })

    const cart = data[0] as
      | {
          payment_collection?: {
            payment_sessions?: PaymentSessionRow[]
          }
        }
      | undefined

    const session = cart?.payment_collection?.payment_sessions?.find(
      (s) => s.provider_id === PROVIDER_ID
    )

    if (!session) {
      res
        .status(404)
        .json({ error: "No MultiSafepay payment session for this cart" })
      return
    }

    const existingData = (session.data ?? {}) as SessionDataShape

    if (
      order_id !== undefined &&
      existingData.mspOrderId !== undefined &&
      String(existingData.mspOrderId) !== String(order_id)
    ) {
      res.status(400).json({ error: "order_id mismatch" })
      return
    }

    await paymentModule.updatePaymentSession({
      id: session.id,
      data: {
        ...existingData,
        transactionId: String(transaction_id),
      } as Record<string, unknown>,
      amount: session.amount,
      currency_code: session.currency_code,
    })

    res.status(200).json({ ok: true })
  } catch (err) {
    logger.error(
      `MultiSafepay authorize endpoint failed: ${(err as Error).message}`
    )
    res.status(500).json({ error: "Failed to update payment session" })
  }
}
