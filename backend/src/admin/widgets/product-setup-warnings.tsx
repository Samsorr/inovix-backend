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
  "shipping_profile.id",
  "variants.id",
  "variants.title",
  "variants.sku",
  "variants.manage_inventory",
  "variants.inventory_items.inventory.id",
  "variants.inventory_items.inventory.location_levels.id",
].join(",")

const Banner = ({ issues }: { issues: SetupIssue[] }) => (
  <div
    style={{
      border: "1px solid #fca5a5",
      background: "#fef2f2",
      padding: "16px 20px",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "8px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "8px",
          height: "8px",
          background: "#dc2626",
        }}
      />
      <Heading level="h3" style={{ color: "#991b1b" }}>
        Dit product is nog niet klaar om te verkopen
      </Heading>
    </div>
    <Text size="small" style={{ color: "#7f1d1d", marginBottom: "12px" }}>
      Klanten kunnen het wel toevoegen aan hun winkelwagen, maar de check-out
      mislukt {issues.length === 1 ? "om de volgende reden" : "om deze redenen"}:
    </Text>
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      {issues.map((issue) => (
        <li
          key={issue.key}
          style={{
            background: "white",
            border: "1px solid #fecaca",
            padding: "10px 12px",
          }}
        >
          <Text size="small" weight="plus" style={{ color: "#991b1b" }}>
            {issue.title}
          </Text>
          <Text size="xsmall" style={{ color: "#7f1d1d", marginTop: "2px" }}>
            {issue.detail}
          </Text>
          <Text size="xsmall" style={{ color: "#0f172a", marginTop: "4px" }}>
            <strong>Oplossing: </strong>
            {issue.fix}
          </Text>
        </li>
      ))}
    </ul>
  </div>
)

const ProductSetupWarningsWidget = ({
  data,
}: DetailWidgetProps<AdminProduct>) => {
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
        // Don't render the banner if the check itself fails | a missing
        // banner is better than a false alarm.
        setIssues([])
      })
    return () => {
      cancelled = true
    }
  }, [data.id, data.updated_at])

  if (!issues || issues.length === 0) return null

  return (
    <Container className="p-0">
      <Banner issues={issues} />
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.before",
})

export default ProductSetupWarningsWidget
