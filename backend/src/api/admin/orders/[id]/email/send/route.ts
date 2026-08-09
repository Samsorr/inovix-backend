import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"

import { applyOverrides } from "../../../../../../lib/order-email-compose"
import { validateOverrides } from "../../../../../../lib/order-email-overrides"
import { isEditableTemplate } from "../../../../../../modules/email-notifications/templates/editable-fields"
import { EmailTemplates } from "../../../../../../modules/email-notifications/templates"
import { sendEmailNotification } from "../../../../../../modules/email-notifications/send-notification"
import { composeForTemplate } from "../compose-for"

// POST /admin/orders/:id/email/send
// Body: { template, overrides?, fulfillment_id? } -> { sent: boolean }
//
// order-shipped is deliberately REFUSED here. That mail carries a side effect
// (markDhlOrderShipped sets shipped_at, registers the shipment and closes the
// order), and a second send path without it would mail a tracking code for an
// order the admin still shows as unshipped. The composer posts an edited
// shipped mail to POST /admin/orders/:id/dhl-label/send-email instead, which
// validates the same overrides and passes them down the one real path.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id
  const logger = req.scope.resolve("logger") as Logger
  const body = (req.body ?? {}) as {
    template?: string
    overrides?: Record<string, string>
    fulfillment_id?: string
  }
  const template = String(body.template ?? "")

  if (!isEditableTemplate(template)) {
    res.status(404).json({
      message: `Sjabloon "${template}" kan niet bewerkt worden.`,
    })
    return
  }

  if (template === EmailTemplates.ORDER_SHIPPED) {
    res.status(400).json({
      message:
        "De verzendmail gaat via 'markeer als verzonden', zodat de bestelling ook echt op verzonden komt te staan.",
    })
    return
  }

  const validated = validateOverrides(template, body.overrides)
  if (!validated.ok) {
    logger.warn(
      `admin.order-email.send: rejected edited copy for order ${orderId}: ${(validated.errors ?? []).join(" ")}`
    )
    res.status(400).json({
      message: "Controleer de ingevulde velden",
      errors: validated.errors ?? [],
    })
    return
  }

  const overrides = validated.value ?? {}
  const edited = Object.keys(overrides).length > 0

  try {
    const composed = await composeForTemplate(
      req.scope,
      orderId,
      template,
      body.fulfillment_id
    )

    if (!composed) {
      res.status(404).json({
        message: "Deze e-mail kan niet voor deze bestelling opgesteld worden.",
      })
      return
    }

    const data = applyOverrides(composed.data, overrides)

    // A unique key on purpose: this route only ever runs because an operator
    // pressed "Versturen", and the base key is almost always spent already, so
    // reusing it would make the send a silent no-op behind a green toast.
    // Same key/trigger policy as sendOrderShippedNotification, so the audit
    // trail reads the same for both templates.
    const suffix = edited ? "edited" : "resend"
    const outcome = await sendEmailNotification(req.scope, {
      to: composed.to,
      channel: "email",
      template: composed.template,
      idempotency_key: `${composed.idempotencyKeyBase}-${suffix}-${Date.now()}`,
      resource_id: composed.resourceId,
      resource_type: "order",
      trigger_type: edited ? "admin.edited" : "admin.resend",
      data,
    })

    logger.info(
      `admin.order-email.send: ${template} for order ${orderId} to ${composed.to} (${edited ? "bewerkt" : "standaardtekst"}, sent=${outcome.sent})`
    )

    res.json({
      sent: outcome.sent === true,
      edited,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
  } catch (err) {
    logger.error(
      `admin.order-email.send: could not send ${template} for order ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ message: "E-mail versturen mislukt." })
  }
}
