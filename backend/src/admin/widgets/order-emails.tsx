import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/types"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

import { EmailComposer } from "../components/email-composer"

type OrderNotification = {
  id: string
  template: string
  to: string
  status: string | null
  created_at: string
  idempotency_key: string | null
  /** True when the operator rewrote the copy before this mail went out. */
  edited?: boolean
  /** The copy it went out with, replayed by the read-only viewer. */
  sent_overrides?: Record<string, string> | null
}

// Friendly Dutch labels for the template ids.
const TEMPLATE_LABELS: Record<string, string> = {
  "order-placed": "Bestelbevestiging",
  "order-shipped": "Verzonden (track & trace)",
  "order-cancelled": "Annulering",
  "order-refunded": "Terugbetaling",
  "payment-failed": "Betaling mislukt",
  "customer-welcome": "Welkom",
  "password-reset": "Wachtwoord herstellen",
  "password-changed": "Wachtwoord gewijzigd",
  "invite-user": "Uitnodiging",
  "abandoned-cart-paid": "Herinnering winkelwagen",
}

// The only two templates the preview endpoint can render for an order, so the
// only two whose text can be shown back. Offering "Bekijk verzonden tekst" on
// the rest would just hand the operator a 404.
const VIEWABLE_TEMPLATES = new Set(["order-placed", "order-shipped"])

function formatWhen(d: string): string {
  try {
    return new Date(d).toLocaleString("nl-NL", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return d
  }
}

const OrderEmailsWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const orderId = data.id
  const [notifications, setNotifications] = useState<OrderNotification[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [sendingConfirmation, setSendingConfirmation] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/notifications`, {
        credentials: "include",
      })
      const json = (await res.json()) as { notifications?: OrderNotification[] }
      setNotifications(json.notifications ?? [])
    } catch {
      setNotifications([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  async function resend(n: OrderNotification) {
    setResendingId(n.id)
    try {
      const res = await fetch(`/admin/orders/${orderId}/notifications`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notification_id: n.id }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(b.message ?? `Mislukt (${res.status})`)
      }
      toast.success(
        `E-mail opnieuw verstuurd: ${TEMPLATE_LABELS[n.template] ?? n.template}`
      )
      void load()
    } catch (e) {
      toast.error("Opnieuw versturen mislukt", {
        description: e instanceof Error ? e.message : "Onbekende fout",
      })
    } finally {
      setResendingId(null)
    }
  }

  // The one-click bestelbevestiging: the existing resend route, which replays
  // the stored confirmation under a unique key and only re-emits order.placed
  // when the order never had one.
  async function sendConfirmation() {
    setSendingConfirmation(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/resend-confirmation`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const body = (await res.json().catch(() => ({}))) as {
        message?: string
        error?: string
        sent?: boolean
        emitted?: boolean
      }
      if (!res.ok) {
        throw new Error(body.message ?? body.error ?? `Mislukt (${res.status})`)
      }
      if (body.emitted) {
        toast.success("Bestelbevestiging in gang gezet", {
          description:
            "Er stond nog geen bevestiging op deze bestelling; hij wordt nu aangemaakt en verstuurd.",
        })
      } else {
        toast.success("Bestelbevestiging opnieuw verstuurd")
      }
      void load()
    } catch (e) {
      toast.error("Versturen mislukt", {
        description: e instanceof Error ? e.message : "Onbekende fout",
      })
    } finally {
      setSendingConfirmation(false)
    }
  }

  if (loading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Verzonden e-mails laden...
          </Text>
        </div>
      </Container>
    )
  }

  if (!notifications) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Verstuur e-mail</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Stuur de bestelbevestiging nog een keer, met de standaardtekst of met
          je eigen tekst. De verzendmail met track-and-trace gaat via de
          Verzendchecklist, zodat de bestelling ook echt op verzonden komt te
          staan.
        </Text>
        <div className="mt-3 flex items-center justify-between gap-4 border border-ui-border-base px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <Text size="small" weight="plus">
              Bestelbevestiging
            </Text>
            <Text size="xsmall" className="text-ui-fg-subtle">
              Overzicht van de bestelling, met totaal en bezorgadres.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              isLoading={sendingConfirmation}
              onClick={() => void sendConfirmation()}
            >
              Versturen
            </Button>
            <EmailComposer
              orderId={orderId}
              template="order-placed"
              onSent={() => void load()}
              trigger={
                <Button variant="secondary" size="small">
                  Bewerken en versturen
                </Button>
              }
            />
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading level="h2">Verzonden e-mails</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Alle e-mails die naar deze klant zijn verstuurd. Klik &quot;Opnieuw
          sturen&quot; als de klant er een niet ontvangen heeft.
        </Text>
      </div>

      {notifications.length === 0 ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-muted">
            Nog geen e-mails verstuurd voor deze bestelling.
          </Text>
        </div>
      ) : (
        <div className="flex flex-col divide-y">
          {notifications.map((n) => (
            <div
              key={n.id}
              className="flex items-center justify-between gap-4 px-6 py-3"
            >
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Text size="small" weight="plus">
                    {TEMPLATE_LABELS[n.template] ?? n.template}
                  </Text>
                  {n.edited ? (
                    <Badge color="orange" size="2xsmall">
                      Bewerkt
                    </Badge>
                  ) : null}
                </div>
                <Text size="xsmall" className="text-ui-fg-subtle">
                  {formatWhen(n.created_at)} | {n.to}
                  {n.status ? ` | ${n.status}` : ""}
                </Text>
              </div>
              <div className="flex items-center gap-2">
                {VIEWABLE_TEMPLATES.has(n.template) ? (
                  <EmailComposer
                    orderId={orderId}
                    template={n.template}
                    readOnly
                    edited={n.edited === true}
                    sentOverrides={n.sent_overrides ?? null}
                    title="Verzonden tekst"
                    trigger={
                      <Button variant="transparent" size="small">
                        Bekijk verzonden tekst
                      </Button>
                    }
                  />
                ) : null}
                <Button
                  variant="secondary"
                  size="small"
                  isLoading={resendingId === n.id}
                  onClick={() => resend(n)}
                >
                  Opnieuw sturen
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderEmailsWidget
