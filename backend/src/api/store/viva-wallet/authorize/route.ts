import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const VIVA_PROVIDER_ID = "pp_viva-wallet_viva"

type RequestBody = {
  cart_id?: string
  transaction_id?: string
  order_code?: string | number
}

type SessionDataShape = {
  orderCode?: number
  checkoutUrl?: string
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

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { cart_id, transaction_id, order_code } = (req.body ?? {}) as RequestBody

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
      (s) => s.provider_id === VIVA_PROVIDER_ID
    )

    if (!session) {
      res.status(404).json({ error: "No Viva payment session for this cart" })
      return
    }

    const existingData = (session.data ?? {}) as SessionDataShape

    if (
      order_code !== undefined &&
      existingData.orderCode !== undefined &&
      String(existingData.orderCode) !== String(order_code)
    ) {
      res.status(400).json({ error: "orderCode mismatch" })
      return
    }

    await paymentModule.updatePaymentSession({
      id: session.id,
      data: {
        ...existingData,
        transactionId: transaction_id,
      } as Record<string, unknown>,
      amount: session.amount,
      currency_code: session.currency_code,
    })

    res.status(200).json({ ok: true })
  } catch (err) {
    logger.error(
      `Viva authorize endpoint failed: ${(err as Error).message}`
    )
    res.status(500).json({ error: "Failed to update payment session" })
  }
}
