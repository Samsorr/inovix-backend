import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"

import {
  editableFieldsFor,
  isEditableTemplate,
} from "../../../../../../modules/email-notifications/templates/editable-fields"
import { composeForTemplate } from "../compose-for"

// GET /admin/orders/:id/email/draft?template=order-shipped[&fulfillment_id=...]
//
// The prefill for the composer drawer: every editable field with the exact text
// the customer would get if the operator changed nothing. The defaults come
// from the registry, applied to the SAME composed payload the send path uses,
// so "leave everything as is and send" is byte-identical to the one-click send.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id
  const logger = req.scope.resolve("logger") as Logger
  const template = String((req.query?.template as string | undefined) ?? "")
  const fulfillmentId = (req.query?.fulfillment_id as string | undefined) || undefined

  if (!isEditableTemplate(template)) {
    res.status(404).json({
      message: `Sjabloon "${template}" kan niet bewerkt worden.`,
    })
    return
  }

  try {
    const composed = await composeForTemplate(
      req.scope,
      orderId,
      template,
      fulfillmentId
    )

    if (!composed) {
      res.status(404).json({
        message: "Deze e-mail kan niet voor deze bestelling opgesteld worden.",
      })
      return
    }

    const fields = editableFieldsFor(template).map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      maxLength: field.maxLength,
      value: field.defaultFor({ locale: composed.locale, data: composed.data }),
    }))

    res.json({
      template,
      to: composed.to,
      locale: composed.locale,
      fields,
    })
  } catch (err) {
    logger.error(
      `admin.order-email.draft: could not build the ${template} draft for order ${orderId}: ${(err as Error).message}`
    )
    res.status(500).json({ message: "Concept ophalen mislukt." })
  }
}
