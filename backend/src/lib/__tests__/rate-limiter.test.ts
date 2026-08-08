import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

import { MAX_BUCKETS, bucketCount, rateLimit } from "../rate-limiter"

type ReqShape = {
  ip?: string
  socket?: { remoteAddress?: string }
  headers: Record<string, unknown>
  path: string
  baseUrl?: string
}

function makeReq(over: Partial<ReqShape> & { path: string }): MedusaRequest {
  return {
    headers: {},
    socket: { remoteAddress: undefined },
    ...over,
  } as unknown as MedusaRequest
}

type FakeRes = MedusaResponse & {
  statusCode: number
  headersSent: Record<string, string>
  body: unknown
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headersSent: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(key: string, value: string) {
      res.headersSent[key] = value
    },
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res as unknown as FakeRes
}

/** Runs the middleware once; returns true when the request was allowed through. */
function hit(
  mw: ReturnType<typeof rateLimit>,
  req: MedusaRequest
): { allowed: boolean; res: FakeRes } {
  const res = makeRes()
  let allowed = false
  mw(req, res, (() => {
    allowed = true
  }) as never)
  return { allowed, res }
}

// Every test uses its own req.path so the module-level bucket map cannot leak
// state between cases.
describe("rateLimit client identity", () => {
  it("does NOT let a rotating X-Forwarded-For escape the limit", () => {
    const mw = rateLimit({ windowMs: 5 * 60 * 1000, max: 3 })
    const results: boolean[] = []

    // One real client (same req.ip, which Express resolved through
    // `trust proxy`), sending a different spoofed XFF on every request | the
    // exact brute-force shape against /auth/user/emailpass.
    for (let i = 0; i < 6; i++) {
      results.push(
        hit(
          mw,
          makeReq({
            path: "/xff-rotation",
            ip: "203.0.113.9",
            headers: { "x-forwarded-for": `10.9.9.${i}, 203.0.113.9` },
          })
        ).allowed
      )
    }

    expect(results).toEqual([true, true, true, false, false, false])
  })

  it("does not let an array-valued X-Forwarded-For escape either", () => {
    const mw = rateLimit({ windowMs: 5 * 60 * 1000, max: 2 })
    const allowed = [0, 1, 2, 3].map(
      (i) =>
        hit(
          mw,
          makeReq({
            path: "/xff-array",
            ip: "203.0.113.10",
            headers: { "x-forwarded-for": [`10.8.8.${i}`, "203.0.113.10"] },
          })
        ).allowed
    )
    expect(allowed).toEqual([true, true, false, false])
  })

  it("still counts distinct real clients separately", () => {
    const mw = rateLimit({ windowMs: 5 * 60 * 1000, max: 1 })
    expect(hit(mw, makeReq({ path: "/per-client", ip: "198.51.100.1" })).allowed).toBe(true)
    expect(hit(mw, makeReq({ path: "/per-client", ip: "198.51.100.1" })).allowed).toBe(false)
    // A different client is unaffected by the first one's exhausted bucket.
    expect(hit(mw, makeReq({ path: "/per-client", ip: "198.51.100.2" })).allowed).toBe(true)
  })

  it("falls back to the socket address, then to a single shared bucket", () => {
    const mw = rateLimit({ windowMs: 5 * 60 * 1000, max: 2 })
    const socketReq = makeReq({
      path: "/fallback-socket",
      socket: { remoteAddress: "198.51.100.7" },
      headers: { "x-forwarded-for": "1.2.3.4" },
    })
    expect(hit(mw, socketReq).allowed).toBe(true)
    expect(hit(mw, socketReq).allowed).toBe(true)
    expect(hit(mw, socketReq).allowed).toBe(false)

    // Neither req.ip nor a socket address: everything keys to "unknown", i.e.
    // one shared bucket. Fail closed, never a fresh bucket per request.
    const mw2 = rateLimit({ windowMs: 5 * 60 * 1000, max: 2 })
    const anon = (i: number) =>
      hit(
        mw2,
        makeReq({
          path: "/fallback-unknown",
          socket: undefined,
          headers: { "x-forwarded-for": `172.16.0.${i}` },
        })
      ).allowed
    expect([anon(1), anon(2), anon(3)]).toEqual([true, true, false])
  })
})

describe("rateLimit behaviour", () => {
  it("answers 429 with Retry-After and the configured message", () => {
    const mw = rateLimit({ windowMs: 60 * 1000, max: 1, message: "Te veel pogingen." })
    const req = makeReq({ path: "/429-shape", ip: "198.51.100.20" })
    hit(mw, req)
    const { allowed, res } = hit(mw, req)

    expect(allowed).toBe(false)
    expect(res.statusCode).toBe(429)
    expect(res.body).toEqual({ type: "rate_limit", message: "Te veel pogingen." })
    expect(res.headersSent["X-RateLimit-Limit"]).toBe("1")
    expect(res.headersSent["X-RateLimit-Remaining"]).toBe("0")
    expect(Number(res.headersSent["Retry-After"])).toBeGreaterThan(0)
  })

  it("is a sliding window: the bucket frees up again after windowMs", () => {
    jest.useFakeTimers()
    try {
      jest.setSystemTime(new Date("2026-08-07T00:00:00Z"))
      const mw = rateLimit({ windowMs: 60 * 1000, max: 2 })
      const req = makeReq({ path: "/sliding", ip: "198.51.100.30" })

      expect(hit(mw, req).allowed).toBe(true)
      expect(hit(mw, req).allowed).toBe(true)
      expect(hit(mw, req).allowed).toBe(false)

      jest.setSystemTime(new Date("2026-08-07T00:01:01Z"))
      expect(hit(mw, req).allowed).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps limiters with different windows in separate buckets", () => {
    const auth = rateLimit({ windowMs: 5 * 60 * 1000, max: 1 })
    const store = rateLimit({ windowMs: 60 * 1000, max: 1 })
    const req = makeReq({ path: "/two-limiters", ip: "198.51.100.40" })

    expect(hit(auth, req).allowed).toBe(true)
    expect(hit(auth, req).allowed).toBe(false)
    // Same path + same ip, but a different limiter: its own budget.
    expect(hit(store, req).allowed).toBe(true)
  })
})

describe("rateLimit memory ceiling", () => {
  it("caps the bucket map so unknown clients cannot grow the heap without bound", () => {
    const mw = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 })
    const before = bucketCount()

    // Far more distinct clients than the ceiling allows, all inside one
    // sweep interval | the memory-exhaustion shape.
    for (let i = 0; i < MAX_BUCKETS + 500; i++) {
      hit(mw, makeReq({ path: "/flood", ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` }))
    }

    expect(bucketCount()).toBeLessThanOrEqual(MAX_BUCKETS)
    expect(bucketCount()).toBeGreaterThan(before)
  })
})
