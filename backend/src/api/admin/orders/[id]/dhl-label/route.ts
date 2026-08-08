import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { createDhlLabelForOrder } from "../../../../../lib/dhl-label"
import { describeLabelFailure } from "../../../../../lib/dhl-label-error"

// All label logic (guards, checklist gate, workflow, N5 notify) lives in
// src/lib/dhl-label.ts, shared with the Telegram bot's Create-label action.
// This route only maps the result union to HTTP.
//
// Failures answer with a Dutch `message` the operator can act on, a `code` for
// the widget, and a sanitised `details` string carrying the real technical
// cause. Every failure used to read "DHL label creation failed" here, which
// left the operator clicking the button again and guessing.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const r = await createDhlLabelForOrder(req.scope, req.params.id)
  switch (r.status) {
    case "not_found":
      res.status(404).json({
        message: `Bestelling ${req.params.id} niet gevonden.`,
        code: "not_found",
        details: null,
      })
      return
    case "checklist_blocked":
      res.status(400).json({
        message:
          "Nog niet alle items zijn afgevinkt op de picklijst. Vink eerst elk item af in de verzendchecklist, of gebruik de override met reden.",
        code: "checklist_blocked",
        details: null,
      })
      return
    case "exists":
      res.status(200).json({
        fulfillment_id: r.fulfillment_id,
        tracking_number: r.tracking_number,
        label_pdf_url: r.label_pdf_url,
        shipment_tracking_url: r.shipment_tracking_url,
        already_existed: true,
      })
      return
    case "created":
      res.status(201).json({
        fulfillment_id: r.fulfillment_id,
        tracking_number: r.tracking_number,
        label_pdf_url: r.label_pdf_url,
        shipment_tracking_url: r.shipment_tracking_url,
      })
      return
    case "invalid": {
      const view = describeLabelFailure(r.message)
      res.status(r.httpStatus).json({
        message: view.message,
        code: view.code,
        // r.details is the MedusaError TYPE ("invalid_data"), useless to an
        // operator; the raw message is the thing worth escalating.
        details: view.details,
        error_type: r.details,
      })
      return
    }
    default: {
      const view = describeLabelFailure(r.message)
      res.status(500).json({
        message: view.message,
        code: view.code,
        details: view.details,
      })
    }
  }
}
