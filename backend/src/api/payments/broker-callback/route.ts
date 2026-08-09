import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { IPaymentModuleService, Logger } from "@medusajs/framework/types"
import { Modules, PaymentActions } from "@medusajs/framework/utils"
import { processPaymentWorkflowId } from "@medusajs/medusa/core-flows"

const PROVIDER_ID = "pp_via_broker_via_broker"

// How far back the ref -> session lookup reaches. A callback lands within
// minutes of the session being created, and sessions come back newest-first, so
// this window is generous; it mirrors jobs/reconcile-broker-payments.ts.
const SESSION_LOOKUP_LIMIT = 300

function ack(res: MedusaResponse, status = 200): void {
  res.status(status).type("text/plain").send("OK")
}

/**
 * Translate the broker's opaque `pay_<hex>` ref into the Medusa payment session
 * id (`payses_...`).
 *
 * The broker only ever knows the ref, and the provider's
 * `getWebhookActionAndData` can only report that. But processPaymentWorkflow
 * treats `data.session_id` as a real payment_session id: it looks the session up
 * by id, follows payment_collection -> cart and completes the cart. Handing it
 * the ref made every lookup miss and threw "PaymentSession with id: pay_... was
 * not found", so no callback ever completed a cart and the reconcile cron had to
 * rescue each order minutes later (found on order #28416, 2026-08-08).
 *
 * The ref lives in the session's `data`, which module filters cannot query, so
 * this scans the most recent broker sessions | the same approach the reconcile
 * job uses.
 */
async function resolvePaymentSessionId(
  paymentModule: IPaymentModuleService,
  ref: string
): Promise<string | null> {
  if (!ref) return null

  const sessions = await paymentModule.listPaymentSessions(
    { provider_id: PROVIDER_ID },
    {
      select: ["id", "data", "created_at"],
      take: SESSION_LOOKUP_LIMIT,
      order: { created_at: "DESC" },
    }
  )

  const match = (sessions ?? []).find(
    (s) => (s?.data as { ref?: string } | null)?.ref === ref
  )
  return match?.id ?? null
}

// Receives POSTs the external-payments broker pushes through the neutral
// relay domain. The provider's `getWebhookActionAndData` verifies the HMAC
// and maps the broker status to a payment action; we then run Medusa's
// processPaymentWorkflow exactly like the native payment-webhook subscriber
// does, so a captured/authorized callback authorizes + captures the payment
// and completes the cart server-side. The customer no longer has to make it
// back to /checkout/return for the order to exist; the reconcile cron stays
// as the safety net behind this.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const paymentModule = req.scope.resolve(Modules.PAYMENT)
  const logger = req.scope.resolve("logger") as Logger

  try {
    const event = await paymentModule.getWebhookActionAndData({
      provider: PROVIDER_ID.replace(/^pp_/, ""),
      payload: {
        data: (req.body ?? {}) as Record<string, unknown>,
        rawData: req.rawBody as Buffer,
        headers: req.headers as Record<string, string>,
      },
    })

    // Mirror @medusajs/medusa's payment-webhook subscriber: only act on
    // captured / authorized / pending. Failed and cancelled callbacks change
    // nothing on the Inovix side (the cart simply never completes and the
    // Mollie payment expires), and not_supported covers HMAC rejections.
    const action = event?.action
    const shouldProcess =
      !!event?.data &&
      action !== PaymentActions.NOT_SUPPORTED &&
      action !== PaymentActions.CANCELED &&
      action !== PaymentActions.FAILED &&
      action !== PaymentActions.REQUIRES_MORE

    if (shouldProcess) {
      // The provider reports the broker ref here; the workflow needs the real
      // payment session id (see resolvePaymentSessionId).
      const ref = String((event.data as { session_id?: string }).session_id ?? "")
      const sessionId = await resolvePaymentSessionId(paymentModule, ref)

      if (!sessionId) {
        // Nothing to complete: the session was replaced or is older than the
        // lookup window. Never fail the callback for it | reconcile-broker-payments
        // still polls the broker and completes anything that is really paid.
        logger.warn(
          `broker-callback: no payment session found for ref ${ref}; leaving it to reconcile-broker-payments`
        )
        ack(res)
        return
      }

      const wfEngine = req.scope.resolve(Modules.WORKFLOW_ENGINE)
      await wfEngine.run(processPaymentWorkflowId, {
        input: { ...event, data: { ...event.data, session_id: sessionId } },
      })
      logger.info(
        `broker-callback processed action=${String(action)} ref=${ref} session=${sessionId}`
      )
    }

    ack(res)
  } catch (err) {
    // Always 200: the broker's retry schedule should not hammer a handler
    // bug, replays are idempotent, and the reconcile cron recovers anything
    // missed here.
    logger.error(`broker-callback handling failed: ${(err as Error).message}`)
    ack(res)
  }
}

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  ack(res)
}
