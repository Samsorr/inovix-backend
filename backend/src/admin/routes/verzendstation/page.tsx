import { defineRouteConfig } from "@medusajs/admin-sdk"
import { TruckFast } from "@medusajs/icons"
import { Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { formatAge } from "./logic"

// The warehouse PC's homepage: only the orders that need action, as large
// tap-friendly rows. Clicking a row opens the order page, where the
// fulfillment checklist widget sits on top and walks the fulfiller through
// the steps. Auto-refreshes every 60s.

type QueueEntry = {
  id: string
  display_id: number | null
  customer_name: string
  item_count: number
  created_at: string | null
  packed_at: string | null
  customer_note: string | null
}

type AttentionReason = {
  code: "payment_unconfirmed" | "manual_fulfillment"
  label: string
  action: string
}

type AttentionEntry = QueueEntry & { reasons: AttentionReason[] }

type Queues = {
  to_process: QueueEntry[]
  to_ship: QueueEntry[]
  // Added later than the two queues: an older backend build (or a cached
  // response) simply omits it, so every read is guarded.
  needs_attention?: AttentionEntry[]
}

const REFRESH_MS = 60_000

function OrderRow({ entry, ageLabel }: { entry: QueueEntry; ageLabel: string }) {
  return (
    <Link
      to={`/verzendstation/${entry.id}`}
      className="block border border-ui-border-base bg-ui-bg-base px-4 py-3 hover:bg-ui-bg-base-hover"
      style={{ textDecoration: "none" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <Text size="large" weight="plus">
            #{entry.display_id ?? "?"} | {entry.customer_name || "Onbekende klant"}
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            {entry.item_count} {entry.item_count === 1 ? "item" : "items"}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          {/* Marker only: the full note is on the order page, this row just has
              to stop the fulfiller from packing past it. */}
          {entry.customer_note ? (
            <span
              title={entry.customer_note}
              className="px-2 py-0.5 text-[10px] uppercase tracking-wider whitespace-nowrap"
              style={{ border: "1px solid #5eead4", background: "#f0fdfa", color: "#0f766e" }}
            >
              Opmerking
            </span>
          ) : null}
          <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
            {ageLabel}
          </Text>
        </div>
      </div>
    </Link>
  )
}

// Deliberately its own block instead of a third queue column: these orders are
// NOT pick work (packing one is either blocked server-side by the payment gate
// or would land on top of a native fulfillment), so mixing them into "Te
// verwerken" would send the operator into a dead end. They are drift that
// needs a decision, so they get their own labelled, explained bucket at the
// top of the page, above the two work queues.
function AttentionBlock({ entries, now }: { entries: AttentionEntry[]; now: number }) {
  return (
    <Container className="p-0" style={{ border: "1px solid #f59e0b" }}>
      <div className="px-4 py-3" style={{ borderBottom: "1px solid #f59e0b", background: "#fffbeb" }}>
        <Heading level="h2">Aandacht nodig ({entries.length})</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Deze bestellingen staan NIET in de werkrijen hiernaast en worden niet
          vanzelf opgelost. Verzend ze pas als het probleem is opgelost.
        </Text>
      </div>
      <div className="flex flex-col gap-2 p-4">
        {entries.map((e) => (
          <Link
            key={e.id}
            to={`/verzendstation/${e.id}`}
            className="block border border-ui-border-base bg-ui-bg-base px-4 py-3 hover:bg-ui-bg-base-hover"
            style={{ textDecoration: "none" }}
          >
            <div className="flex items-center justify-between gap-3">
              <Text size="large" weight="plus">
                #{e.display_id ?? "?"} | {e.customer_name || "Onbekende klant"}
              </Text>
              <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
                {e.created_at ? `${formatAge(e.created_at, now)} besteld` : ""}
              </Text>
            </div>
            {e.reasons.map((r) => (
              <div key={r.code} className="mt-2">
                <Text size="small" weight="plus" style={{ color: "#b45309" }}>
                  {r.label}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  {r.action}
                </Text>
              </div>
            ))}
          </Link>
        ))}
      </div>
    </Container>
  )
}

function QueueColumn({
  title,
  subtitle,
  entries,
  emptyLabel,
  ageOf,
  urgent,
}: {
  title: string
  subtitle: string
  entries: QueueEntry[]
  emptyLabel: string
  ageOf: (e: QueueEntry) => string
  urgent?: boolean
}) {
  return (
    <Container className="p-0">
      <div
        className="px-4 py-3"
        style={
          urgent && entries.length > 0
            ? { borderBottom: "1px solid #fcd34d", background: "#fffbeb" }
            : { borderBottom: "1px solid var(--border-base, #e5e7eb)" }
        }
      >
        <Heading level="h2">
          {title} ({entries.length})
        </Heading>
        <Text size="small" className="text-ui-fg-subtle">
          {subtitle}
        </Text>
      </div>
      <div className="flex flex-col gap-2 p-4">
        {entries.length === 0 ? (
          <Text size="small" className="text-ui-fg-muted">
            {emptyLabel}
          </Text>
        ) : (
          entries.map((e) => <OrderRow key={e.id} entry={e} ageLabel={ageOf(e)} />)
        )}
      </div>
    </Container>
  )
}

const VerzendstationPage = () => {
  const [queues, setQueues] = useState<Queues | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  async function load() {
    try {
      const res = await fetch("/admin/verzendstation/queue", { credentials: "include" })
      if (!res.ok) throw new Error(`Laden mislukt (${res.status})`)
      setQueues((await res.json()) as Queues)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout")
    }
  }

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const now = updatedAt ?? Date.now()
  const attention = queues?.needs_attention ?? []

  return (
    <div className="flex flex-col gap-4">
      <Container className="p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h1">Verzendstation</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Alle bestellingen die actie nodig hebben. Klik op een bestelling en
              volg de verzendchecklist. Ververst elke minuut.
            </Text>
            {attention.length > 0 ? (
              <Text size="small" weight="plus" className="mt-1" style={{ color: "#b45309" }}>
                Let op: {attention.length}{" "}
                {attention.length === 1 ? "bestelling heeft" : "bestellingen hebben"}{" "}
                aandacht nodig (zie hieronder). Een lege werkrij betekent dan niet
                dat alles klaar is.
              </Text>
            ) : null}
          </div>
          {error ? (
            <Text size="small" className="text-ui-fg-error">
              {error}
            </Text>
          ) : null}
        </div>
      </Container>

      {queues === null && !error ? (
        <Container className="p-6">
          <Text size="small" className="text-ui-fg-subtle">
            Laden...
          </Text>
        </Container>
      ) : queues ? (
        <>
          {attention.length > 0 ? <AttentionBlock entries={attention} now={now} /> : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <QueueColumn
              title="Te verwerken"
              subtitle="Betaald, nog geen DHL-label"
              entries={queues.to_process}
              // "Goed bezig!" may only be said when there is genuinely nothing
              // left, attention rows included.
              emptyLabel={
                attention.length > 0
                  ? "Niets te verwerken, maar kijk eerst naar 'Aandacht nodig' hierboven."
                  : "Niets te verwerken. Goed bezig!"
              }
              ageOf={(e) => (e.created_at ? `${formatAge(e.created_at, now)} besteld` : "")}
            />
            <QueueColumn
              title="Ingepakt, nog niet verzonden"
              subtitle="Label gemaakt, maar nog niet gemarkeerd als verzonden"
              entries={queues.to_ship}
              emptyLabel="Alles is verzonden."
              ageOf={(e) => (e.packed_at ? `label ${formatAge(e.packed_at, now)}` : "")}
              urgent
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Verzendstation",
  icon: TruckFast,
})

export default VerzendstationPage
