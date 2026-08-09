import {
  Button,
  FocusModal,
  Input,
  Label,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import {
  changedOverrides,
  defaultValues,
  draftUrl,
  PREVIEW_DEBOUNCE_MS,
  sendOutcomeToast,
  sendRequestFor,
  serverErrorText,
  type EmailDraft,
} from "./email-composer.logic"

// ─── Order email composer ────────────────────────────────────────────────────
//
// One drawer, mounted from the fulfillment checklist (order-shipped) and from
// the E-mails widget (order-placed). Left half: the editable fields exactly as
// the backend registry declares them. Right half: the REAL email, rendered by
// the preview route through the same generateEmailTemplate + render() pair the
// Resend provider runs, so what the operator proofreads is what the customer
// gets.
//
// Single-shot by design (see the spec): closing throws the edit away. There is
// no draft persistence and no free-form composer.

type ErrorBox = { message: string }

export type EmailComposerProps = {
  orderId: string
  /** "order-shipped" or "order-placed". */
  template: string
  /** The button that opens the drawer. */
  trigger: ReactNode
  /** Pins the shipped mail to one fulfillment; resolved server-side when absent. */
  fulfillmentId?: string
  /** Read-only: show what went out, no fields and no send button. */
  readOnly?: boolean
  /** Read-only only: this mail was sent with rewritten copy. */
  edited?: boolean
  /**
   * Read-only only: the copy this mail actually went out with, as returned by
   * GET /admin/orders/:id/notifications. Replayed through the preview endpoint
   * so the operator sees what the customer got, not the standard template.
   */
  sentOverrides?: Record<string, string> | null
  /** Overrides the drawer title. */
  title?: string
  /** Called after a successful send so the caller can refresh its list. */
  onSent?: () => void
}

const inlineErrorStyle = {
  border: "1px solid #fca5a5",
  background: "#fef2f2",
  padding: "8px 12px",
}

export function EmailComposer({
  orderId,
  template,
  trigger,
  fulfillmentId,
  readOnly = false,
  edited = false,
  sentOverrides = null,
  title,
  onSent,
}: EmailComposerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EmailDraft | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<ErrorBox | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  // Every preview request gets a sequence number and only the newest one is
  // allowed to write state. Without it a slow early request lands after a fast
  // later one and the operator proofreads text they already replaced.
  const previewSeq = useRef(0)
  // First render is immediate (nothing on screen yet), every later one waits
  // out the typing. Tracked separately from `previewHtml` so a preview that
  // keeps failing does not fire a request per keystroke.
  const previewPrimed = useRef(false)

  const defaults = draft ? defaultValues(draft.fields ?? []) : {}

  const runPreview = useCallback(
    async (overrides: Record<string, string>) => {
      const seq = ++previewSeq.current
      setPreviewing(true)
      try {
        const res = await fetch(`/admin/orders/${orderId}/email/preview`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template,
            overrides,
            ...(fulfillmentId ? { fulfillment_id: fulfillmentId } : {}),
          }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          html?: string
          message?: string
          errors?: string[]
        }
        if (seq !== previewSeq.current) return
        if (!res.ok) {
          // The previous preview deliberately stays on screen: a blank pane
          // over a typo in one field hides the rest of the mail as well.
          setPreviewError(serverErrorText(res.status, body))
          return
        }
        setPreviewError(null)
        setPreviewHtml(typeof body.html === "string" ? body.html : "")
      } catch {
        if (seq !== previewSeq.current) return
        setPreviewError(
          "Voorbeeld laden mislukt. Controleer de verbinding en typ iets om het opnieuw te proberen."
        )
      } finally {
        if (seq === previewSeq.current) setPreviewing(false)
      }
    },
    [orderId, template, fulfillmentId]
  )

  // Load the prefilled fields when the drawer opens.
  useEffect(() => {
    if (!open || readOnly) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const res = await fetch(draftUrl(orderId, template, fulfillmentId), {
          credentials: "include",
        })
        const body = (await res.json().catch(() => ({}))) as EmailDraft & {
          message?: string
          errors?: string[]
        }
        if (cancelled) return
        if (!res.ok) {
          setLoadError({ message: serverErrorText(res.status, body) })
          return
        }
        setDraft({ ...body, fields: Array.isArray(body.fields) ? body.fields : [] })
        setValues(defaultValues(Array.isArray(body.fields) ? body.fields : []))
      } catch {
        if (cancelled) return
        setLoadError({
          message: "Concept ophalen mislukt. Controleer de verbinding.",
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [open, readOnly, orderId, template, fulfillmentId])

  // Debounced preview.
  useEffect(() => {
    if (!open || readOnly || !draft) return
    const overrides = changedOverrides(defaultValues(draft.fields ?? []), values)
    const delay = previewPrimed.current ? PREVIEW_DEBOUNCE_MS : 0
    previewPrimed.current = true
    const timer = setTimeout(() => void runPreview(overrides), delay)
    return () => clearTimeout(timer)
  }, [open, readOnly, draft, values, runPreview])

  // Read-only: one render of the stored mail, no fields to react to. Replaying
  // the copy this mail was SENT with is the whole point; rendering the plain
  // template here would show the operator the one mail they did not send.
  useEffect(() => {
    if (!open || !readOnly) return
    void runPreview(sentOverrides ?? {})
  }, [open, readOnly, runPreview, sentOverrides])

  // Closing throws the edit away (no draft persistence, by design).
  useEffect(() => {
    if (open) return
    previewSeq.current++
    previewPrimed.current = false
    setDraft(null)
    setValues({})
    setPreviewHtml(null)
    setPreviewError(null)
    setLoadError(null)
    setPreviewing(false)
    setLoading(false)
  }, [open])

  function setFieldValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  async function send() {
    if (!draft) return
    const overrides = changedOverrides(defaults, values)
    const request = sendRequestFor(orderId, template, overrides)
    setSending(true)
    try {
      const res = await fetch(request.url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      })
      const body = (await res.json().catch(() => ({}))) as {
        message?: string
        errors?: string[]
        sent?: boolean
        edited?: boolean
        reason?: string
      }
      if (!res.ok) {
        toast.error("E-mail versturen mislukt", {
          description: serverErrorText(res.status, body),
        })
        return
      }
      const outcome = sendOutcomeToast(body, draft.to)
      if (outcome.tone === "warning") {
        toast.warning(outcome.title, { description: outcome.description })
      } else {
        toast.success(outcome.title, { description: outcome.description })
      }
      setOpen(false)
      onSent?.()
    } catch (err) {
      toast.error("E-mail versturen mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
    } finally {
      setSending(false)
    }
  }

  const heading =
    title ?? (readOnly ? "Verzonden e-mail" : "E-mail bewerken en versturen")

  return (
    <FocusModal open={open} onOpenChange={setOpen}>
      <FocusModal.Trigger asChild>{trigger}</FocusModal.Trigger>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex flex-col gap-0.5">
            <FocusModal.Title>{heading}</FocusModal.Title>
            {draft?.to ? (
              <Text size="xsmall" className="text-ui-fg-subtle">
                Aan: {draft.to}
              </Text>
            ) : null}
          </div>
        </FocusModal.Header>

        <FocusModal.Body className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* Left: the editable fields */}
            {readOnly ? null : (
              <div className="flex w-full flex-col gap-4 overflow-y-auto border-b border-ui-border-base p-6 lg:w-2/5 lg:border-b-0 lg:border-r">
                {loading ? (
                  <Text size="small" className="text-ui-fg-subtle">
                    Concept laden...
                  </Text>
                ) : null}

                {loadError ? (
                  <div style={inlineErrorStyle}>
                    <Text size="small" weight="plus" style={{ color: "#991b1b" }}>
                      Concept ophalen mislukt
                    </Text>
                    <Text size="small" style={{ color: "#7f1d1d", marginTop: "2px" }}>
                      {loadError.message}
                    </Text>
                  </div>
                ) : null}

                {draft ? (
                  <>
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      Pas alleen aan wat je wilt wijzigen. Wat je niet aanraakt
                      blijft de standaardtekst, in de taal van de klant. De
                      aanhef, de productregels, het adresblok en de voettekst
                      staan vast.
                    </Text>
                    {draft.fields.map((field) => {
                      const value = values[field.key] ?? ""
                      const isChanged = value.trim() !== (field.value ?? "").trim()
                      const inputId = `email-composer-${field.key}`
                      return (
                        <div key={field.key} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <Label htmlFor={inputId} size="small" weight="plus">
                              {field.label}
                            </Label>
                            {isChanged ? (
                              <button
                                type="button"
                                className="txt-small text-ui-fg-interactive hover:underline"
                                onClick={() => setFieldValue(field.key, field.value ?? "")}
                              >
                                Herstel standaard
                              </button>
                            ) : null}
                          </div>
                          {field.type === "textarea" ? (
                            <Textarea
                              id={inputId}
                              rows={4}
                              maxLength={field.maxLength}
                              value={value}
                              onChange={(e) => setFieldValue(field.key, e.target.value)}
                            />
                          ) : (
                            <Input
                              id={inputId}
                              type="text"
                              maxLength={field.maxLength}
                              value={value}
                              onChange={(e) => setFieldValue(field.key, e.target.value)}
                            />
                          )}
                          <Text size="xsmall" className="text-ui-fg-muted">
                            {value.length} / {field.maxLength} tekens
                            {isChanged ? " | aangepast" : ""}
                          </Text>
                        </div>
                      )
                    })}
                  </>
                ) : null}
              </div>
            )}

            {/* Right: the live preview */}
            <div className="flex min-h-0 w-full flex-1 flex-col gap-2 bg-ui-bg-subtle p-6">
              <div className="flex items-center justify-between gap-2">
                <Text size="small" weight="plus">
                  Voorbeeld
                </Text>
                <Text size="xsmall" className="text-ui-fg-muted">
                  {previewing ? "bijwerken..." : "zo ziet de klant de e-mail"}
                </Text>
              </div>

              {readOnly ? (
                <Text size="xsmall" className="text-ui-fg-subtle">
                  {edited
                    ? "Deze e-mail is met aangepaste tekst verstuurd. Hieronder staat die tekst, zoals de klant hem heeft ontvangen."
                    : "Dit is de e-mail zoals de klant hem heeft ontvangen."}
                </Text>
              ) : null}

              {previewError ? (
                <div style={inlineErrorStyle}>
                  <Text size="small" weight="plus" style={{ color: "#991b1b" }}>
                    Voorbeeld bijwerken mislukt
                  </Text>
                  <Text size="small" style={{ color: "#7f1d1d", marginTop: "2px" }}>
                    {previewError} Je kunt de e-mail nog steeds versturen; wat je
                    hierboven invult wordt gecontroleerd door de server.
                  </Text>
                </div>
              ) : null}

              {previewHtml === null ? (
                <div className="flex flex-1 items-center justify-center border border-ui-border-base bg-white">
                  <Text size="small" className="text-ui-fg-subtle">
                    Voorbeeld laden...
                  </Text>
                </div>
              ) : (
                <iframe
                  title="Voorbeeld van de e-mail"
                  srcDoc={previewHtml}
                  sandbox="allow-same-origin"
                  className="min-h-0 w-full flex-1 border border-ui-border-base bg-white"
                  style={{ minHeight: 420 }}
                />
              )}
            </div>
          </div>
        </FocusModal.Body>

        <FocusModal.Footer>
          <div className="flex items-center justify-end gap-2">
            <FocusModal.Close asChild>
              <Button variant="secondary" size="small" disabled={sending}>
                {readOnly ? "Sluiten" : "Annuleren"}
              </Button>
            </FocusModal.Close>
            {readOnly ? null : (
              <Button
                variant="primary"
                size="small"
                isLoading={sending}
                disabled={!draft || loading}
                onClick={() => void send()}
              >
                Versturen
              </Button>
            )}
          </div>
        </FocusModal.Footer>
      </FocusModal.Content>
    </FocusModal>
  )
}

export default EmailComposer
