import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/types"
import {
  Container,
  Heading,
  Button,
  Text,
  toast,
  IconButton,
} from "@medusajs/ui"
import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Image from "@tiptap/extension-image"
import Link from "@tiptap/extension-link"
import Placeholder from "@tiptap/extension-placeholder"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const ACCEPTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

type ImageNodeRef = { pos: number; src: string }

function readLongDescription(metadata: Record<string, unknown> | null | undefined): string {
  const raw = metadata?.long_description
  return typeof raw === "string" ? raw : ""
}

async function uploadFileToMedusa(file: File): Promise<string> {
  const form = new FormData()
  form.append("files", file)
  const res = await fetch("/admin/uploads", {
    method: "POST",
    credentials: "include",
    body: form,
  })
  if (!res.ok) {
    throw new Error(`upload failed (${res.status})`)
  }
  const json = (await res.json()) as { files?: Array<{ url?: string }> }
  const url = json.files?.[0]?.url
  if (!url) {
    throw new Error("no url returned from /admin/uploads")
  }
  return url
}

async function rehostExternalImage(sourceUrl: string): Promise<string> {
  const res = await fetch("/admin/custom/fetch-image", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: sourceUrl }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `fetch-image failed (${res.status})`)
  }
  const json = (await res.json()) as { url?: string }
  if (!json.url) {
    throw new Error("no url returned from fetch-image")
  }
  return json.url
}

function dataUrlToFile(dataUrl: string, fallbackName = "pasted-image"): File {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    throw new Error("not a base64 data url")
  }
  const [, mime, base64] = match
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const ext = mime.split("/")[1]?.split("+")[0] || "bin"
  return new File([bytes], `${fallbackName}.${ext}`, { type: mime })
}

function findImageNodes(editor: Editor): ImageNodeRef[] {
  const out: ImageNodeRef[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") {
      const src = typeof node.attrs.src === "string" ? node.attrs.src : ""
      out.push({ pos, src })
    }
  })
  return out
}

function replaceImageSrc(editor: Editor, pos: number, newSrc: string): void {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    src: newSrc,
  })
  editor.view.dispatch(tr)
}

function needsRehosting(src: string, processed: Set<string>): boolean {
  if (!src) return false
  if (processed.has(src)) return false
  if (src.startsWith("data:")) return true
  if (src.startsWith("http://") || src.startsWith("https://")) return true
  return false
}

const ProductDescriptionWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const initialHtml = useMemo(
    () =>
      readLongDescription(
        data.metadata as Record<string, unknown> | null | undefined
      ),
    [data.metadata]
  )

  const [savedHtml, setSavedHtml] = useState<string>(initialHtml)
  const [saving, setSaving] = useState(false)
  const [pendingImages, setPendingImages] = useState(0)
  const [currentHtml, setCurrentHtml] = useState<string>(initialHtml)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const processedSrcs = useRef<Set<string>>(new Set())
  const scanning = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          class: "inovix-editor-image",
        },
      }),
      Placeholder.configure({
        placeholder:
          "Plak hier de uitgebreide productbeschrijving. Afbeeldingen worden automatisch naar Inovix-opslag verplaatst.",
      }),
    ],
    content: initialHtml || "",
    onUpdate: ({ editor }) => {
      setCurrentHtml(editor.getHTML())
      void scanAndRehost(editor)
    },
    editorProps: {
      attributes: {
        class: "inovix-editor-prose",
      },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []).filter(
          (f) => ACCEPTED_IMAGE_MIMES.includes(f.type)
        )
        if (files.length === 0) return false

        event.preventDefault()
        void (async () => {
          for (const file of files) {
            if (file.size > MAX_IMAGE_BYTES) {
              toast.error("Afbeelding te groot", {
                description: `${file.name}: max ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
              })
              continue
            }
            setPendingImages((n) => n + 1)
            try {
              const url = await uploadFileToMedusa(file)
              processedSrcs.current.add(url)
              editor?.chain().focus().setImage({ src: url }).run()
            } catch (err) {
              toast.error("Upload mislukt", {
                description: err instanceof Error ? err.message : "onbekende fout",
              })
            } finally {
              setPendingImages((n) => Math.max(0, n - 1))
            }
          }
        })()
        return true
      },
    },
  })

  const scanAndRehost = useCallback(
    async (ed: Editor) => {
      if (scanning.current) return
      scanning.current = true
      try {
        const nodes = findImageNodes(ed).filter((n) =>
          needsRehosting(n.src, processedSrcs.current)
        )
        if (nodes.length === 0) return

        const uniqueSrcs = Array.from(new Set(nodes.map((n) => n.src)))

        for (const src of uniqueSrcs) {
          processedSrcs.current.add(src)
          setPendingImages((n) => n + 1)
          try {
            let newUrl: string
            if (src.startsWith("data:")) {
              const file = dataUrlToFile(src)
              newUrl = await uploadFileToMedusa(file)
            } else {
              newUrl = await rehostExternalImage(src)
            }
            processedSrcs.current.add(newUrl)

            let remaining = findImageNodes(ed).filter((n) => n.src === src)
            while (remaining.length > 0) {
              replaceImageSrc(ed, remaining[0].pos, newUrl)
              remaining = findImageNodes(ed).filter((n) => n.src === src)
            }
          } catch (err) {
            toast.error("Afbeelding kon niet gehost worden", {
              description:
                err instanceof Error
                  ? `${err.message}. De originele URL blijft staan.`
                  : "onbekende fout",
            })
          } finally {
            setPendingImages((n) => Math.max(0, n - 1))
          }
        }
      } finally {
        scanning.current = false
      }
    },
    []
  )

  useEffect(() => {
    if (editor && initialHtml && editor.getHTML() !== initialHtml) {
      editor.commands.setContent(initialHtml, { emitUpdate: false })
      setCurrentHtml(initialHtml)
    }
  }, [editor, initialHtml])

  const dirty = currentHtml.trim() !== savedHtml.trim()

  const onManualImageUpload = () => {
    fileInputRef.current?.click()
  }

  const onFileSelected = async (file: File) => {
    if (!ACCEPTED_IMAGE_MIMES.includes(file.type)) {
      toast.error("Onjuist bestandstype", {
        description: "Alleen JPG, PNG, WebP, GIF of SVG toegestaan.",
      })
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Afbeelding te groot", {
        description: `Max ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`,
      })
      return
    }
    setPendingImages((n) => n + 1)
    try {
      const url = await uploadFileToMedusa(file)
      processedSrcs.current.add(url)
      editor?.chain().focus().setImage({ src: url }).run()
    } catch (err) {
      toast.error("Upload mislukt", {
        description: err instanceof Error ? err.message : "onbekende fout",
      })
    } finally {
      setPendingImages((n) => Math.max(0, n - 1))
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const onInsertLink = () => {
    if (!editor) return
    const prev = editor.getAttributes("link").href as string | undefined
    const url = window.prompt("Voer de URL in", prev ?? "https://")
    if (url === null) return
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      return
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url, target: "_blank", rel: "noopener noreferrer nofollow" })
      .run()
  }

  const onSave = async () => {
    if (!editor) return
    if (pendingImages > 0) {
      toast.warning("Wacht op afbeeldingen", {
        description: "Afbeeldingen worden nog geüpload. Probeer opnieuw.",
      })
      return
    }

    setSaving(true)
    const html = editor.getHTML()
    const cleaned = html === "<p></p>" ? "" : html

    try {
      const existing = (data.metadata ?? {}) as Record<string, unknown>
      const nextMetadata: Record<string, unknown> = { ...existing }
      if (cleaned) {
        nextMetadata.long_description = cleaned
      } else {
        delete nextMetadata.long_description
      }

      const res = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: nextMetadata }),
      })
      if (!res.ok) {
        throw new Error(`opslaan mislukt (${res.status})`)
      }
      setSavedHtml(cleaned)
      setCurrentHtml(cleaned)
      toast.success("Beschrijving opgeslagen")
    } catch (err) {
      toast.error("Opslaan mislukt", {
        description: err instanceof Error ? err.message : "onbekende fout",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <style>{`
        .inovix-editor-prose { outline: none; min-height: 260px; padding: 12px; font-size: 13px; line-height: 1.55; color: var(--fg-base, #0f172a); }
        .inovix-editor-prose:focus { outline: none; }
        .inovix-editor-prose h2 { font-size: 18px; font-weight: 700; margin: 18px 0 8px; }
        .inovix-editor-prose h3 { font-size: 15px; font-weight: 600; margin: 14px 0 6px; }
        .inovix-editor-prose p { margin: 0 0 10px; }
        .inovix-editor-prose ul { list-style: disc; padding-left: 20px; margin: 0 0 10px; }
        .inovix-editor-prose ol { list-style: decimal; padding-left: 20px; margin: 0 0 10px; }
        .inovix-editor-prose a { color: #6d28d9; text-decoration: underline; }
        .inovix-editor-prose img.inovix-editor-image { max-width: 100%; height: auto; margin: 12px 0; border-radius: 4px; border: 1px solid #e5e7eb; display: block; }
        .inovix-editor-prose blockquote { border-left: 3px solid #e5e7eb; padding-left: 12px; color: #475569; margin: 10px 0; }
        .inovix-editor-prose code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
        .inovix-editor-prose p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: #94a3b8; float: left; height: 0; pointer-events: none; }
        .inovix-editor-toolbar-btn { font-size: 12px; font-weight: 500; min-width: 28px; padding: 4px 8px; }
        .inovix-editor-toolbar-btn[data-active="true"] { background: #e2e8f0; }
      `}</style>

      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Uitgebreide productbeschrijving</Heading>
      </div>

      <div className="px-6 py-4">
        <Text className="txt-small text-ui-fg-subtle mb-4">
          Plak hier de volledige beschrijving (koppen, paragrafen, lijsten, afbeeldingen). Externe
          afbeeldingen worden automatisch gedownload en op onze eigen opslag gehost, zodat ze niet
          verdwijnen als de bron offline gaat.
        </Text>

        {editor && (
          <>
            <div className="flex flex-wrap items-center gap-1 border border-ui-border-base rounded-t-md bg-ui-bg-subtle px-2 py-1.5">
              <ToolbarButton
                label="Vet"
                active={editor.isActive("bold")}
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <b>B</b>
              </ToolbarButton>
              <ToolbarButton
                label="Cursief"
                active={editor.isActive("italic")}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <i>I</i>
              </ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton
                label="Kop 2"
                active={editor.isActive("heading", { level: 2 })}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 2 }).run()
                }
              >
                H2
              </ToolbarButton>
              <ToolbarButton
                label="Kop 3"
                active={editor.isActive("heading", { level: 3 })}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 3 }).run()
                }
              >
                H3
              </ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton
                label="Lijst"
                active={editor.isActive("bulletList")}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                •
              </ToolbarButton>
              <ToolbarButton
                label="Nummering"
                active={editor.isActive("orderedList")}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                1.
              </ToolbarButton>
              <ToolbarButton
                label="Citaat"
                active={editor.isActive("blockquote")}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
              >
                ❝
              </ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton
                label="Link"
                active={editor.isActive("link")}
                onClick={onInsertLink}
              >
                🔗
              </ToolbarButton>
              <ToolbarButton
                label="Afbeelding uploaden"
                onClick={onManualImageUpload}
              >
                🖼
              </ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton
                label="Opmaak wissen"
                onClick={() =>
                  editor.chain().focus().clearNodes().unsetAllMarks().run()
                }
              >
                ⨯
              </ToolbarButton>
              <ToolbarButton
                label="Ongedaan maken"
                onClick={() => editor.chain().focus().undo().run()}
              >
                ↶
              </ToolbarButton>
              <ToolbarButton
                label="Opnieuw"
                onClick={() => editor.chain().focus().redo().run()}
              >
                ↷
              </ToolbarButton>
            </div>
            <div className="border-x border-b border-ui-border-base rounded-b-md bg-ui-bg-base">
              <EditorContent editor={editor} />
            </div>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_MIMES.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onFileSelected(file)
          }}
        />

        {pendingImages > 0 && (
          <Text className="txt-small text-ui-fg-subtle mt-3">
            {pendingImages} afbeelding{pendingImages === 1 ? "" : "en"} worden
            verplaatst naar Inovix-opslag…
          </Text>
        )}

        <details className="mt-4">
          <summary className="txt-small text-ui-fg-subtle cursor-pointer">
            Hoe werkt dit?
          </summary>
          <ul className="txt-small text-ui-fg-subtle mt-2 list-disc pl-4 space-y-1">
            <li>Kopieer de beschrijving van de bron (webpagina, Word, Google Docs).</li>
            <li>Plak met Ctrl/Cmd+V in het bovenstaande vak.</li>
            <li>
              Afbeeldingen die uit een externe bron komen, worden automatisch naar onze eigen
              opslag verplaatst zodat ze blijven werken.
            </li>
            <li>
              Wacht tot het bericht &quot;worden verplaatst&quot; verdwijnt voordat je opslaat.
            </li>
            <li>
              Gebruik de werkbalk om koppen, lijsten, links en extra afbeeldingen toe te voegen.
            </li>
          </ul>
        </details>
      </div>

      <div className="flex items-center justify-end px-6 py-4 gap-x-2">
        {dirty && (
          <Text className="txt-small text-ui-fg-subtle">Niet-opgeslagen wijzigingen</Text>
        )}
        <Button
          variant="primary"
          size="small"
          disabled={!dirty || saving || pendingImages > 0}
          isLoading={saving}
          onClick={onSave}
        >
          Opslaan
        </Button>
      </div>
    </Container>
  )
}

type ToolbarButtonProps = {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({ label, active, onClick, children }: ToolbarButtonProps) {
  return (
    <IconButton
      size="small"
      variant="transparent"
      className="inovix-editor-toolbar-btn"
      data-active={active ? "true" : "false"}
      onClick={onClick}
      aria-label={label}
      title={label}
      type="button"
    >
      {children}
    </IconButton>
  )
}

function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px bg-ui-border-base" aria-hidden />
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductDescriptionWidget
