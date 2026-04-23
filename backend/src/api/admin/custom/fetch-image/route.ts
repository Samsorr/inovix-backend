import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import type { IFileModuleService, Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { ulid } from "ulid"

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
}

const MAX_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

type Body = {
  url?: string
}

function isHttpUrl(input: string): URL | null {
  try {
    const u = new URL(input)
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u
    }
    return null
  } catch {
    return null
  }
}

function filenameFromUrl(u: URL, ext: string): string {
  const last = u.pathname.split("/").filter(Boolean).pop() || "image"
  const base = last.replace(/\.[^.]+$/, "") || "image"
  const safe = base.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 48)
  return `${safe}-${ulid()}.${ext}`
}

export async function POST(
  req: MedusaRequest<Body>,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger") as Logger
  const url = req.body?.url?.trim()

  if (!url) {
    res.status(400).json({ error: "url is required" })
    return
  }

  const parsed = isHttpUrl(url)
  if (!parsed) {
    res.status(400).json({ error: "url must be http(s)" })
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "InovixAdmin/1.0 (image-proxy)",
        accept: "image/*",
      },
    })

    if (!response.ok) {
      res
        .status(502)
        .json({ error: `source returned ${response.status}` })
      return
    }

    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase()

    const extension = ALLOWED_MIME_TYPES[contentType]
    if (!extension) {
      res.status(415).json({
        error: `unsupported content-type: ${contentType || "unknown"}`,
      })
      return
    }

    const contentLengthHeader = response.headers.get("content-length")
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader)
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        res.status(413).json({ error: "image too large" })
        return
      }
    }

    const arrayBuf = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuf)
    if (buffer.length > MAX_BYTES) {
      res.status(413).json({ error: "image too large" })
      return
    }

    const fileModule = req.scope.resolve(Modules.FILE) as IFileModuleService
    const filename = filenameFromUrl(parsed, extension)

    const file = await fileModule.createFiles({
      filename,
      mimeType: contentType,
      content: buffer.toString("base64"),
    })

    logger.info(
      `admin.fetch-image: re-hosted ${parsed.hostname} → ${file.url}`
    )

    res.status(200).json({ url: file.url, id: file.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (controller.signal.aborted) {
      logger.warn(`admin.fetch-image: timeout fetching ${url}`)
      res.status(504).json({ error: "source timed out" })
      return
    }
    logger.error(`admin.fetch-image failed for ${url}: ${message}`)
    res.status(500).json({ error: "failed to fetch image" })
  } finally {
    clearTimeout(timeout)
  }
}
