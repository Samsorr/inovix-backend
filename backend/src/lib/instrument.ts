import * as Sentry from "@sentry/node"

const dsn = process.env.SENTRY_DSN

// Medusa loads this file twice in production (once from the source-tree
// medusa-config and once from the bundled copy under .medusa/server, each
// resolving @sentry/node from a different node_modules). Without this guard
// both copies patch http.Server and every request infinite-recurses through
// the two wrappers (RangeError: Maximum call stack size exceeded).
const SENTRY_INIT_FLAG = "__INOVIX_SENTRY_INITIALIZED__"

if (dsn && !(globalThis as Record<string, unknown>)[SENTRY_INIT_FLAG]) {
  (globalThis as Record<string, unknown>)[SENTRY_INIT_FLAG] = true
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
  })
}

export { Sentry }
