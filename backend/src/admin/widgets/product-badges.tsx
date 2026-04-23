import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/types"
import {
  Container,
  Heading,
  Switch,
  Label,
  Button,
  toast,
} from "@medusajs/ui"
import { useMemo, useState } from "react"

type BadgeKey = "hplc_tested" | "third_party_verified" | "eu_shipping"

const BADGE_OPTIONS: { key: BadgeKey; label: string; description: string }[] = [
  {
    key: "hplc_tested",
    label: "HPLC getest",
    description: "Toon 'HPLC GETEST' badge op de productpagina",
  },
  {
    key: "third_party_verified",
    label: "3rd-party verified",
    description: "Toon '3RD-PARTY VERIFIED' badge op de productpagina",
  },
  {
    key: "eu_shipping",
    label: "EU verzending",
    description: "Toon 'EU VERZENDING' badge op de productpagina",
  },
]

function readBadges(metadata: Record<string, unknown> | null | undefined): BadgeKey[] {
  const raw = metadata?.badges
  if (!Array.isArray(raw)) return []
  const allowed = new Set<string>(BADGE_OPTIONS.map((b) => b.key))
  return raw.filter((v): v is BadgeKey => typeof v === "string" && allowed.has(v))
}

const ProductBadgesWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const initial = useMemo(
    () => readBadges(data.metadata as Record<string, unknown> | null | undefined),
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
      toast.success("Badges opgeslagen")
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
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Trust badges</Heading>
      </div>
      <div className="px-6 py-4">
        <p className="txt-small text-ui-fg-subtle mb-4">
          Selecteer welke badges op de productpagina worden getoond. De zuiverheid-badge wordt los
          beheerd via het <code>purity</code> metadata-veld.
        </p>
        <div className="flex flex-col gap-y-4">
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
                  <span className="txt-small text-ui-fg-subtle">
                    {opt.description}
                  </span>
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
      <div className="flex items-center justify-end px-6 py-4">
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
