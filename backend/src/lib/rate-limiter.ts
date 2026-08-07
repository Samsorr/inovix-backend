import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"

type Bucket = {
  timestamps: number[]
  // The window this bucket was created with. The map holds buckets from every
  // rateLimit() instance, so a sweep must prune each one against its OWN
  // window (the 5-minute /auth bucket must not be pruned with the 1-minute
  // /store window).
  windowMs: number
}

export type RateLimitOptions = {
  windowMs: number
  max: number
  message?: string
}

const buckets = new Map<string, Bucket>()

/**
 * Hard ceiling on how many buckets we keep in memory. A single Railway
 * container holds the whole map, so the number of live keys must not be a
 * function of how many distinct clients decide to show up: a botnet, or one
 * host walking an IPv6 /64, would otherwise grow the heap until the container
 * is OOM-killed.
 */
export const MAX_BUCKETS = 20000

/** Live bucket count. Exported so the limiter's tests can assert the ceiling. */
export function bucketCount(): number {
  return buckets.size
}

/**
 * The client address as Express resolved it. Medusa sets `trust proxy` to 1
 * (`@medusajs/framework/dist/http/express-loader.js`), so `req.ip` is already
 * the address the platform proxy saw, one hop back.
 *
 * Never parse X-Forwarded-For here. The LEFTMOST entry of that header is
 * whatever the client typed | a proxy appends the address it observed on the
 * right | so keying on it hands every request its own bucket, which both
 * nullifies the /auth/* brute-force limit and grows the map without bound.
 * If a deeper proxy chain ever needs trusting, raise `trust proxy` instead.
 */
function getClientIp(req: MedusaRequest): string {
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
// When the map is at its ceiling we sweep far more eagerly, but still not on
// every request: a full pass is O(buckets).
const PRESSURE_SWEEP_INTERVAL_MS = 1000

function sweep(now: number) {
  lastSweep = now
  for (const [key, bucket] of buckets.entries()) {
    prune(bucket, now - bucket.windowMs)
    if (bucket.timestamps.length === 0) buckets.delete(key)
  }
}

function maybeSweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  sweep(now)
}

function makeRoom(now: number) {
  if (buckets.size < MAX_BUCKETS) return
  if (now - lastSweep >= PRESSURE_SWEEP_INTERVAL_MS) sweep(now)
  // Still full after dropping the expired ones: evict the longest-standing
  // keys (a Map iterates in insertion order). Eviction weakens the limit for
  // whoever gets evicted, which is the right trade against running out of
  // memory, and with req.ip as the key an attacker cannot aim it.
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next()
    if (oldest.done) break
    buckets.delete(oldest.value)
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

    maybeSweep(now)

    let bucket = buckets.get(key)
    if (!bucket) {
      makeRoom(now)
      bucket = { timestamps: [], windowMs }
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
