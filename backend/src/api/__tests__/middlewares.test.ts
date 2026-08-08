import middlewares from "../middlewares"

type Route = {
  matcher: string | RegExp
  methods?: string[]
  method?: string | string[]
  middlewares?: unknown[]
  bodyParser?: unknown
}

const routes = (middlewares.routes ?? []) as Route[]
const byMatcher = (m: string) => routes.find((r) => r.matcher === m)

describe("middleware rate limits", () => {
  it("rate limits the public Telegram webhook", () => {
    // @InovixOpsBot's username is public, so any Telegram user can make this
    // route run. Without a limiter each DM costs an outbound send plus a DB
    // write, and a sustained flood starves the bot's quota until a real order
    // notification is dropped.
    const route = byMatcher("/webhooks/telegram")
    expect(route).toBeDefined()
    expect(route!.middlewares?.length).toBe(1)
    // `methods` (plural), not the deprecated `method`: Medusa 2.12.1's loader
    // reads only the plural form and silently ignores the other.
    expect(route!.methods).toEqual(["POST"])
  })

  it("rate limits every unauthenticated-reachable namespace it is meant to", () => {
    for (const matcher of ["/auth/*", "/admin/*", "/store/*", "/webhooks/telegram"]) {
      expect(byMatcher(matcher)?.middlewares?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it("still preserves the raw body on the HMAC-verified callbacks", () => {
    // Regression guard: the broker callback verifies its HMAC over the exact
    // raw bytes, so losing this entry silently rejects every payment callback.
    for (const matcher of [
      "/payments/broker-callback",
      "/webhooks/ops/sentry",
      "/webhooks/ops/vercel",
    ]) {
      expect(byMatcher(matcher)?.bodyParser).toEqual({ preserveRawBody: true })
    }
  })
})
