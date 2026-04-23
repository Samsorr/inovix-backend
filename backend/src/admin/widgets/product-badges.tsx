import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/types"
import {
  Container,
  Heading,
  Switch,
  Label,
  Button,
  Text,
  toast,
} from "@medusajs/ui"
import { useMemo, useState } from "react"

type BadgeKey = "hplc_tested" | "third_party_verified" | "eu_shipping"

const BADGE_OPTIONS: {
  key: BadgeKey
  label: string
  storefrontLabel: string
  dotColor: string
  when: string
}[] = [
  {
    key: "hplc_tested",
    label: "HPLC getest",
    storefrontLabel: "HPLC GETEST",
    dotColor: "#5eead4",
    when: "Aanvinken als dit product een HPLC-zuiverheidstest heeft ondergaan. Gebruik dit samen met een purity-waarde in de specs.",
  },
  {
    key: "third_party_verified",
    label: "3rd-party verified",
    storefrontLabel: "3RD-PARTY VERIFIED",
    dotColor: "#a78bfa",
    when: "Aanvinken als er een onafhankelijk lab-rapport (CoA) van een externe partij beschikbaar is. Upload het CoA via het Certificaat-widget hiernaast.",
  },
  {
    key: "eu_shipping",
    label: "EU verzending",
    storefrontLabel: "EU VERZENDING",
    dotColor: "#a78bfa",
    when: "Aanvinken voor producten die we vanuit de EU versturen (dus geen douane voor EU-klanten).",
  },
]

function readBadges(
  metadata: Record<string, unknown> | null | undefined
): BadgeKey[] {
  const raw = metadata?.badges
  if (!Array.isArray(raw)) return []
  const allowed = new Set<string>(BADGE_OPTIONS.map((b) => b.key))
  return raw.filter(
    (v): v is BadgeKey => typeof v === "string" && allowed.has(v)
  )
}

function readPurity(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  const raw = metadata?.purity
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

const PreviewBadge = ({
  dotColor,
  children,
}: {
  dotColor: string
  children: React.ReactNode
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      border: "1px solid var(--border-base, #e5e7eb)",
      background: "var(--bg-subtle, #f6f6f7)",
      padding: "6px 10px",
      fontSize: "10px",
      fontWeight: 500,
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: "#0f172a",
    }}
  >
    <span
      aria-hidden="true"
      style={{
        display: "block",
        width: "6px",
        height: "6px",
        background: dotColor,
      }}
    />
    {children}
  </span>
)

const ProductBadgesWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const initial = useMemo(
    () => readBadges(data.metadata as Record<string, unknown> | null | undefined),
    [data.metadata]
  )
  const purity = useMemo(
    () => readPurity(data.metadata as Record<string, unknown> | null | undefined),
    [data.metadata]
  )
  const [selected, setSelected] = useState<BadgeKey[]>(initial)
  const [saving, setSaving] = useState(false)

  const dirty =
    initial.length !== selected.length ||
    initial.some((k) => !selected.includes(k)) ||
    selected.some((k) => !initial.includes(k))

  const toggle = (key: BadgeKey, value: boolean) => {
    setSelected((prev) =>
      value ? [...prev, key] : prev.filter((k) => k !== key)
    )
  }

  const save = async () => {
    setSaving(true)
    try {
      const nextMetadata = {
        ...(data.metadata ?? {}),
        badges: selected,
      }
      const res = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: nextMetadata }),
      })
      if (!res.ok) {
        throw new Error(`Failed (${res.status})`)
      }
      toast.success("Trust badges opgeslagen")
    } catch (err) {
      toast.error("Opslaan mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      {/* Header + explainer */}
      <div className="px-6 py-4">
        <Heading level="h2">Trust badges</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Deze badges verschijnen op de productpagina direct onder de titel.
          Ze bouwen vertrouwen op bij onderzoekers. Zet alleen aan wat echt van
          toepassing is op dit product | misleidende claims kosten je klanten.
        </Text>
      </div>

      {/* Live preview */}
      <div className="px-6 py-4">
        <Text size="xsmall" weight="plus" className="text-ui-fg-muted mb-2">
          Zo ziet het eruit op de site
        </Text>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            padding: "12px",
            background: "var(--bg-base, #fff)",
            border: "1px solid var(--border-base, #e5e7eb)",
            borderRadius: "4px",
            minHeight: "48px",
            alignItems: "center",
          }}
        >
          {purity != null && (
            <PreviewBadge dotColor="#5eead4">
              ≥{purity}% ZUIVERHEID
            </PreviewBadge>
          )}
          {selected.map((key) => {
            const opt = BADGE_OPTIONS.find((o) => o.key === key)!
            return (
              <PreviewBadge key={key} dotColor={opt.dotColor}>
                {opt.storefrontLabel}
              </PreviewBadge>
            )
          })}
          {purity == null && selected.length === 0 && (
            <Text size="small" className="text-ui-fg-muted">
              Geen badges geselecteerd | dit vak blijft leeg op de productpagina.
            </Text>
          )}
        </div>
        {purity == null && (
          <Text size="xsmall" className="text-ui-fg-subtle mt-2">
            Tip: de zuiverheid-badge (bv. &ge;99% ZUIVERHEID) komt automatisch
            erbij als je het <code>purity</code> metadata-veld invult.
          </Text>
        )}
      </div>

      {/* Switches */}
      <div className="px-6 py-4">
        <div className="flex flex-col gap-y-5">
          {BADGE_OPTIONS.map((opt) => {
            const checked = selected.includes(opt.key)
            const id = `badge-${opt.key}`
            return (
              <div
                key={opt.key}
                className="flex items-start justify-between gap-x-4"
              >
                <div className="flex flex-col">
                  <Label htmlFor={id} className="txt-small font-medium">
                    {opt.label}
                  </Label>
                  <Text size="xsmall" className="text-ui-fg-subtle mt-1">
                    {opt.when}
                  </Text>
                </div>
                <Switch
                  id={id}
                  checked={checked}
                  onCheckedChange={(v) => toggle(opt.key, Boolean(v))}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-between px-6 py-4">
        <Text size="xsmall" className="text-ui-fg-subtle">
          {dirty ? "Niet opgeslagen wijzigingen" : "Alles opgeslagen"}
        </Text>
        <Button
          variant="primary"
          size="small"
          disabled={!dirty || saving}
          isLoading={saving}
          onClick={save}
        >
          Opslaan
        </Button>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.side.after",
})

export default ProductBadgesWidget
