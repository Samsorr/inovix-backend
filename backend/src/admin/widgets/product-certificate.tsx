import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/types"
import {
  Container,
  Heading,
  Button,
  Text,
  toast,
} from "@medusajs/ui"
import { useMemo, useRef, useState } from "react"

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
const ACCEPTED_MIME_TYPES = ["application/pdf"]

type UploadedFile = {
  id?: string
  url: string
}

function readCoaUrl(metadata: Record<string, unknown> | null | undefined): string | null {
  const raw = metadata?.coa_url
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split("/").filter(Boolean).pop()
    return last ? decodeURIComponent(last) : url
  } catch {
    return url
  }
}

const ProductCertificateWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const initial = useMemo(
    () => readCoaUrl(data.metadata as Record<string, unknown> | null | undefined),
    [data.metadata]
  )

  const [currentUrl, setCurrentUrl] = useState<string | null>(initial)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const dirty = currentUrl !== initial

  const persistMetadata = async (nextUrl: string | null) => {
    setSaving(true)
    try {
      const existing = (data.metadata ?? {}) as Record<string, unknown>
      const nextMetadata: Record<string, unknown> = { ...existing }
      if (nextUrl) {
        nextMetadata.coa_url = nextUrl
      } else {
        delete nextMetadata.coa_url
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
      toast.success(nextUrl ? "Certificaat opgeslagen" : "Certificaat verwijderd")
    } catch (err) {
      toast.error("Opslaan mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
      throw err
    } finally {
      setSaving(false)
    }
  }

  const handleFileSelected = async (file: File) => {
    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      toast.error("Onjuist bestandstype", {
        description: "Alleen PDF-bestanden zijn toegestaan.",
      })
      return
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      toast.error("Bestand te groot", {
        description: `Maximaal ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.`,
      })
      return
    }

    setUploading(true)
    try {
      const form = new FormData()
      form.append("files", file)
      const res = await fetch("/admin/uploads", {
        method: "POST",
        credentials: "include",
        body: form,
      })
      if (!res.ok) {
        throw new Error(`Upload mislukt (${res.status})`)
      }
      const json = (await res.json()) as { files?: UploadedFile[] }
      const uploaded = json.files?.[0]
      if (!uploaded?.url) {
        throw new Error("Geen URL ontvangen van de server")
      }
      setCurrentUrl(uploaded.url)
      toast.success("Bestand geüpload, klik op Opslaan om te bevestigen")
    } catch (err) {
      toast.error("Upload mislukt", {
        description: err instanceof Error ? err.message : "Onbekende fout",
      })
    } finally {
      setUploading(false)
      if (inputRef.current) {
        inputRef.current.value = ""
      }
    }
  }

  const onRemove = () => {
    setCurrentUrl(null)
  }

  const onSave = async () => {
    try {
      await persistMetadata(currentUrl)
    } catch {
      // toast already shown
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Certificaat van Analyse (CoA)</Heading>
      </div>
      <div className="px-6 py-4">
        <Text className="txt-small text-ui-fg-subtle mb-4">
          Upload een PDF-certificaat of bewijsstuk dat klanten vanaf de
          productpagina kunnen downloaden. Max {MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.
        </Text>

        {currentUrl ? (
          <div className="flex items-center justify-between gap-x-4 rounded-md border border-ui-border-base px-3 py-2">
            <a
              href={currentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="txt-small truncate text-ui-fg-interactive hover:underline"
            >
              {filenameFromUrl(currentUrl)}
            </a>
            <Button
              variant="secondary"
              size="small"
              onClick={onRemove}
              disabled={saving || uploading}
            >
              Verwijderen
            </Button>
          </div>
        ) : (
          <Text className="txt-small text-ui-fg-muted">
            Nog geen certificaat geüpload.
          </Text>
        )}

        <div className="mt-4 flex items-center gap-x-2">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                void handleFileSelected(file)
              }
            }}
          />
          <Button
            variant="secondary"
            size="small"
            isLoading={uploading}
            disabled={uploading || saving}
            onClick={() => inputRef.current?.click()}
          >
            {currentUrl ? "Vervang bestand" : "Upload PDF"}
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-end px-6 py-4">
        <Button
          variant="primary"
          size="small"
          disabled={!dirty || saving || uploading}
          isLoading={saving}
          onClick={onSave}
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

export default ProductCertificateWidget
