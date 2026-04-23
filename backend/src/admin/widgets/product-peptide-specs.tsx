import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/types"
import {
  Container,
  Heading,
  Input,
  Textarea,
  Label,
  Button,
  Text,
  toast,
} from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"

type FieldKey =
  | "category"
  | "sequence"
  | "molecular_formula"
  | "molecular_weight"
  | "cas_number"
  | "purity"
  | "physical_state"
  | "solubility"
  | "shelf_life"
  | "storage_temp"
  | "handling_notes"

type FieldDef = {
  key: FieldKey
  label: string
  placeholder: string
  help: string
  multiline?: boolean
  numeric?: boolean
  suffix?: string
}

type SectionDef = {
  title: string
  subtitle: string
  fields: FieldDef[]
}

const SECTIONS: SectionDef[] = [
  {
    title: "Categorie & positionering",
    subtitle:
      "Verschijnt als klein label bóven de producttitel op de productpagina.",
    fields: [
      {
        key: "category",
        label: "Categorie",
        placeholder: "Bijv. Groeihormoon peptide",
        help: "Korte categorie in hoofdletters boven de titel. Houd het kort (max 3 woorden).",
      },
    ],
  },
  {
    title: "Chemische identiteit",
    subtitle:
      "Deze velden verschijnen in de tab 'Specificaties' op de productpagina. Laat leeg wat je niet zeker weet | lege rijen worden automatisch verborgen.",
    fields: [
      {
        key: "sequence",
        label: "Aminozuur-sequentie",
        placeholder:
          "Bijv. His-Ser-Asp-Ala-Val-Phe-Thr-Asp-Asn-Tyr-Thr-Arg-Leu-Arg-Lys-Gln-Met-Ala-Val-Lys-Lys-Tyr-Leu-Asn-Ser-Ile-Leu-Asn-NH2",
        help: "Volledige peptide-sequentie, met streepjes tussen residuen. Exact zoals op het CoA staat.",
        multiline: true,
      },
      {
        key: "molecular_formula",
        label: "Moleculaire formule",
        placeholder: "Bijv. C149H246N44O42S",
        help: "Brutoformule. Gebruik hoofdletters voor atoomsymbolen en cijfers direct erachter (geen subscripts).",
      },
      {
        key: "molecular_weight",
        label: "Molecuulmassa",
        placeholder: "Bijv. 3357.88 g/mol",
        help: "Inclusief eenheid. Meestal in g/mol, soms Da.",
      },
      {
        key: "cas_number",
        label: "CAS-nummer",
        placeholder: "Bijv. 158861-67-7",
        help: "Chemical Abstracts Service registratienummer. Laat leeg als het peptide er (nog) geen heeft.",
      },
      {
        key: "purity",
        label: "Zuiverheid (%)",
        placeholder: "Bijv. 99",
        help: "Alleen het getal, zonder %-teken. Dit stuurt automatisch de 'ZUIVERHEID'-badge naast de titel aan.",
        numeric: true,
        suffix: "%",
      },
    ],
  },
  {
    title: "Fysische eigenschappen",
    subtitle: "Verschijnen in de tab 'Specificaties'.",
    fields: [
      {
        key: "physical_state",
        label: "Fysische toestand",
        placeholder: "Bijv. Gevriesdroogd wit poeder",
        help: "Hoe komt het product uit de vial? Bijvoorbeeld 'gevriesdroogd poeder' of 'heldere oplossing'.",
      },
      {
        key: "solubility",
        label: "Oplosbaarheid",
        placeholder: "Bijv. Oplosbaar in bacteriostatisch water",
        help: "In welk oplosmiddel lost het op, en hoe snel/volledig.",
      },
    ],
  },
  {
    title: "Opslag & handling",
    subtitle:
      "Verschijnen in de tab 'Opslag & Handling'. Deze informatie voorkomt dat onderzoekers het product verpesten door verkeerde opslag.",
    fields: [
      {
        key: "shelf_life",
        label: "Houdbaarheid",
        placeholder: "Bijv. 24 maanden bij -20°C",
        help: "Hoe lang het product stabiel blijft, onder welke temperatuur.",
      },
      {
        key: "storage_temp",
        label: "Opslagtemperatuur",
        placeholder: "Bijv. -20°C tot -80°C",
        help: "Aanbevolen bewaartemperatuur. Gebruik een bereik of een enkele waarde.",
      },
      {
        key: "handling_notes",
        label: "Hanterings-notities",
        placeholder:
          "Bijv. Voorkom herhaald invriezen en ontdooien. Laat vial op kamertemperatuur komen voor opening.",
        help: "Losse tips of waarschuwingen die buiten de standaardvelden vallen.",
        multiline: true,
      },
    ],
  },
]

const ALL_FIELDS: FieldDef[] = SECTIONS.flatMap((s) => s.fields)

function readValues(
  metadata: Record<string, unknown> | null | undefined
): Record<FieldKey, string> {
  const out = {} as Record<FieldKey, string>
  for (const field of ALL_FIELDS) {
    const raw = metadata?.[field.key]
    out[field.key] =
      raw === null || raw === undefined
        ? ""
        : typeof raw === "string"
          ? raw
          : String(raw)
  }
  return out
}

function buildMetadataPatch(
  values: Record<FieldKey, string>,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...existing }
  for (const field of ALL_FIELDS) {
    const trimmed = values[field.key].trim()
    if (trimmed === "") {
      delete next[field.key]
    } else if (field.numeric) {
      const n = Number(trimmed)
      next[field.key] = Number.isFinite(n) ? n : trimmed
    } else {
      next[field.key] = trimmed
    }
  }
  return next
}

const ProductPeptideSpecsWidget = ({
  data,
}: DetailWidgetProps<AdminProduct>) => {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>
  const initial = useMemo(() => readValues(metadata), [metadata])
  const [values, setValues] = useState<Record<FieldKey, string>>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValues(initial)
  }, [initial])

  const dirty = ALL_FIELDS.some((f) => values[f.key] !== initial[f.key])
  const invalidPurity =
    values.purity.trim() !== "" && !Number.isFinite(Number(values.purity))

  const update = (key: FieldKey, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }))
  }

  const save = async () => {
    if (invalidPurity) {
      toast.error("Zuiverheid moet een getal zijn", {
        description: "Vul bijvoorbeeld 99 in, zonder %-teken of komma.",
      })
      return
    }
    setSaving(true)
    try {
      const nextMetadata = buildMetadataPatch(values, metadata)
      const res = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: nextMetadata }),
      })
      if (!res.ok) {
        throw new Error(`Failed (${res.status})`)
      }
      toast.success("Peptide-specs opgeslagen")
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
      <div className="px-6 py-4">
        <Heading level="h2">Peptide specs</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Vul deze velden in voor elk peptide. Alles wat je hier invult,
          verschijnt op de productpagina onder de bijbehorende tabs. Lege
          velden worden automatisch verborgen. Vertrouw op de voorbeelden
          rechts van elk label als je twijfelt over het formaat.
        </Text>
      </div>

      {SECTIONS.map((section) => (
        <div key={section.title} className="px-6 py-5">
          <Heading level="h3" className="mb-1">
            {section.title}
          </Heading>
          <Text size="small" className="text-ui-fg-subtle mb-4">
            {section.subtitle}
          </Text>

          <div className="flex flex-col gap-y-5">
            {section.fields.map((field) => {
              const id = `pep-${field.key}`
              return (
                <div key={field.key} className="flex flex-col gap-y-1.5">
                  <Label htmlFor={id} className="txt-small font-medium">
                    {field.label}
                    {field.suffix && (
                      <span className="text-ui-fg-muted ml-1 font-normal">
                        ({field.suffix})
                      </span>
                    )}
                  </Label>
                  {field.multiline ? (
                    <Textarea
                      id={id}
                      placeholder={field.placeholder}
                      value={values[field.key]}
                      onChange={(e) => update(field.key, e.target.value)}
                      rows={field.key === "sequence" ? 3 : 2}
                    />
                  ) : (
                    <Input
                      id={id}
                      placeholder={field.placeholder}
                      value={values[field.key]}
                      onChange={(e) => update(field.key, e.target.value)}
                      inputMode={field.numeric ? "decimal" : undefined}
                    />
                  )}
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {field.help}
                  </Text>
                  {field.key === "purity" && invalidPurity && (
                    <Text size="xsmall" className="text-ui-fg-error">
                      Dit moet een getal zijn (bijv. 99 of 99.5).
                    </Text>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between px-6 py-4">
        <Text size="xsmall" className="text-ui-fg-subtle">
          {dirty ? "Niet opgeslagen wijzigingen" : "Alles opgeslagen"}
        </Text>
        <Button
          variant="primary"
          size="small"
          disabled={!dirty || saving || invalidPurity}
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
  zone: "product.details.after",
})

export default ProductPeptideSpecsWidget
