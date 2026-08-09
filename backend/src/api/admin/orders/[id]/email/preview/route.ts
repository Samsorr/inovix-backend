import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import { render } from "@react-email/render"
import type { ReactElement } from "react"

import { applyOverrides } from "../../../../../../lib/order-email-compose"
import { validateOverrides } from "../../../../../../lib/order-email-overrides"
import { isEditableTemplate } from "../../../../../../modules/email-notifications/templates/editable-fields"
import { generateEmailTemplate } from "../../../../../../modules/email-notifications/templates"
import { composeForTemplate } from "../compose-for"

// POST /admin/orders/:id/email/preview
// Body: { template, overrides?, fulfillment_id? } -> { html, subject }
//
// The whole feature exists to stop an edited mail differing from what the
// operator proofread, so this renders through `generateEmailTemplate` +
// `render()`: the exact pair the Resend provider runs in
// modules/email-notifications/services/resend.ts. The payload is built by the
// same `composeForTemplate` + `applyOverrides` the send path uses. Any shortcut
// here (a hand-built payload, a different renderer) reintroduces the drift.
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

  // Validated BEFORE anything is composed or rendered: a rejected field must
  // never reach a template, not even in a preview.
  const validated = validateOverrides(template, body.overrides)
  if (!validated.ok) {
    res.status(400).json({
      message: "Controleer de ingevulde velden",
      errors: validated.errors ?? [],
    })
    return
  }

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

    const data = applyOverrides(composed.data, validated.value ?? {})
    const element = generateEmailTemplate(template, data)
    const html = await render(element as ReactElement)

    res.json({ html, subject: data.emailOptions?.subject ?? "" })
  } catch (err) {
    logger.error(
      `admin.order-email.preview: could not render ${template} for order ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ message: "Voorbeeld maken mislukt." })
  }
}
