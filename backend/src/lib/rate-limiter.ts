import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"

type Bucket = {
  timestamps: number[]
}

export type RateLimitOptions = {
  windowMs: number
  max: number
  message?: string
}

const buckets = new Map<string, Bucket>()

function getClientIp(req: MedusaRequest): string {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim()
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]!.split(",")[0]!.trim()
  }
  return req.ip || req.socket?.remoteAddress || "unknown"
}

function prune(bucket: Bucket, cutoff: number) {
  let i = 0
  while (i < bucket.timestamps.length && bucket.timestamps[i]! < cutoff) {
    i++
  }
  if (i > 0) bucket.timestamps.splice(0, i)
}

let lastSweep = Date.now()
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

function maybeSweep(now: number, windowMs: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  const cutoff = now - windowMs
  for (const [key, bucket] of buckets.entries()) {
    prune(bucket, cutoff)
    if (bucket.timestamps.length === 0) buckets.delete(key)
  }
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, message } = options

  return function rateLimitMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const now = Date.now()
    const ip = getClientIp(req)
    const key = `${req.baseUrl ?? ""}${req.path}:${ip}:${windowMs}:${max}`

    maybeSweep(now, windowMs)

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { timestamps: [] }
      buckets.set(key, bucket)
    }

    const cutoff = now - windowMs
    prune(bucket, cutoff)

    if (bucket.timestamps.length >= max) {
      const oldest = bucket.timestamps[0]!
      const retryAfterMs = windowMs - (now - oldest)
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
      res.setHeader("Retry-After", String(retryAfterSec))
      res.setHeader("X-RateLimit-Limit", String(max))
      res.setHeader("X-RateLimit-Remaining", "0")
      res.status(429).json({
        type: "rate_limit",
        message: message ?? "Too many requests. Please try again later.",
      })
      return
    }

    bucket.timestamps.push(now)
    res.setHeader("X-RateLimit-Limit", String(max))
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, max - bucket.timestamps.length))
    )

    next()
  }
}
