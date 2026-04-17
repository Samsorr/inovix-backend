import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"

import { VivaClient } from "../../../modules/payment-viva-wallet/client"
import type { VivaEnvironment } from "../../../modules/payment-viva-wallet/types"

const PROVIDER_ID = "pp_viva-wallet_viva"

function getClient(): VivaClient | null {
  const merchantId = process.env.VIVA_MERCHANT_ID
  const apiKey = process.env.VIVA_API_KEY
  const clientId = process.env.VIVA_CLIENT_ID
  const clientSecret = process.env.VIVA_CLIENT_SECRET
  if (!merchantId || !apiKey || !clientId || !clientSecret) return null
  return new VivaClient({
    clientId,
    clientSecret,
    merchantId,
    apiKey,
    environment:
      (process.env.VIVA_ENVIRONMENT as VivaEnvironment | undefined) ??
      "production",
  })
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = getClient()
  if (!client) {
    res.status(500).json({
      error: "Viva credentials not configured on the server",
    })
    return
  }

  try {
    const key = await client.getWebhookVerificationKey()
    res.status(200).json({ Key: key })
  } catch (err) {
    const logger = req.scope.resolve("logger") as {
      error: (message: string) => void
    }
    logger.error(
      `Viva webhook verification key fetch failed: ${(err as Error).message}`
    )
    res.status(500).json({ error: "failed to fetch verification key" })
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const paymentModule = req.scope.resolve(Modules.PAYMENT)

  try {
    await paymentModule.getWebhookActionAndData({
      provider: PROVIDER_ID,
      payload: {
        data: req.body as Record<string, unknown>,
        rawData: req.rawBody as Buffer,
        headers: req.headers as Record<string, string>,
      },
    })
    res.status(200).json({ received: true })
  } catch (err) {
    const logger = req.scope.resolve("logger") as {
      error: (message: string) => void
    }
    logger.error(`Viva webhook handling failed: ${(err as Error).message}`)
    // Respond 2xx so Viva doesn't retry forever — our own retry/alerting
    // happens via Sentry when Sentry is wired.
    res.status(200).json({ received: false })
  }
}
