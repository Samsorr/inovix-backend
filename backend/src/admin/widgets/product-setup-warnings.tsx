import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminProduct, DetailWidgetProps } from "@medusajs/types"
import { Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

import {
  detectSetupIssues,
  type SetupCheckProduct,
  type SetupIssue,
} from "./product-setup-warnings.logic"

const FIELDS = [
  "id",
  // detectSetupIssues only flags "sells without stock control" on live products.
  "status",
  "weight",
  "thumbnail",
  "images.id",
  "shipping_profile.id",
  "variants.id",
  "variants.title",
  "variants.sku",
  "variants.manage_inventory",
  "variants.prices.amount",
  "variants.inventory_items.inventory.id",
  "variants.inventory_items.inventory.location_levels.id",
].join(",")

type Tone = "red" | "amber" | "green"

const TONES: Record<Tone, { border: string; bg: string; dot: string; head: string; body: string }> = {
  red: { border: "#fca5a5", bg: "#fef2f2", dot: "#dc2626", head: "#991b1b", body: "#7f1d1d" },
  amber: { border: "#fcd34d", bg: "#fffbeb", dot: "#d97706", head: "#92400e", body: "#78350f" },
  green: { border: "#86efac", bg: "#f0fdf4", dot: "#16a34a", head: "#166534", body: "#14532d" },
}

const Banner = ({
  tone,
  heading,
  intro,
  issues,
}: {
  tone: Tone
  heading: string
  intro: string
  issues: SetupIssue[]
}) => {
  const c = TONES[tone]
  return (
    <div style={{ border: `1px solid ${c.border}`, background: c.bg, padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span
          aria-hidden="true"
          style={{ display: "inline-block", width: "8px", height: "8px", background: c.dot }}
        />
        <Heading level="h3" style={{ color: c.head }}>
          {heading}
        </Heading>
      </div>
      <Text size="small" style={{ color: c.body, marginBottom: issues.length ? "12px" : 0 }}>
        {intro}
      </Text>
      {issues.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
          {issues.map((issue) => (
            <li key={issue.key} style={{ background: "white", border: `1px solid ${c.border}`, padding: "10px 12px" }}>
              <Text size="small" weight="plus" style={{ color: c.head }}>
                {issue.title}
              </Text>
              <Text size="xsmall" style={{ color: c.body, marginTop: "2px" }}>
                {issue.detail}
              </Text>
              <Text size="xsmall" style={{ color: "#0f172a", marginTop: "4px" }}>
                <strong>Oplossing: </strong>
                {issue.fix}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ProductSetupWarningsWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const [issues, setIssues] = useState<SetupIssue[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const url = `/admin/products/${data.id}?fields=${encodeURIComponent(FIELDS)}`
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json: { product?: SetupCheckProduct }) => {
        if (cancelled) return
        setIssues(detectSetupIssues(json.product))
      })
      .catch(() => {
        if (cancelled) return
        // Don't render anything if the check itself fails | a missing banner is
        // better than a false alarm.
        setIssues([])
      })
    return () => {
      cancelled = true
    }
  }, [data.id, data.updated_at])

  if (issues === null) return null

  // `published` = Live on the website; anything else (draft/proposed/rejected)
  // = Concept, not shown to customers.
  const isLive = data.status === "published"

  if (issues.length === 0) {
    // Complete + already live: nothing to flag.
    if (isLive) return null
    // Complete + still Concept: tell the operator it's safe to go live.
    return (
      <Container className="p-0">
        <Banner
          tone="green"
          heading="Klaar om live te zetten"
          intro='Dit product is compleet. Zet de status rechtsboven op "Published" (Live) om het op de website te tonen.'
          issues={[]}
        />
      </Container>
    )
  }

  return (
    <Container className="p-0">
      <Banner
        tone={isLive ? "red" : "amber"}
        heading={
          isLive
            ? "Dit product staat LIVE maar is nog niet compleet"
            : "Nog niet klaar om live te zetten"
        }
        intro={
          isLive
            ? "Klanten kunnen het nu kopen terwijl onderstaande info nog mist, wat tot mislukte of niet-verzendbare bestellingen leidt. Zet het op Concept (status “Draft”) tot het compleet is, of vul aan:"
            : "Dit product staat op Concept en is nog niet zichtbaar op de site. Vul onderstaande aan; daarna kun je het op Live (“Published”) zetten:"
        }
        issues={issues}
      />
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.before",
})

export default ProductSetupWarningsWidget
