import { authenticate, defineMiddlewares } from "@medusajs/framework/http"

import { friendlyErrorHandler } from "../lib/friendly-error-handler"
import { passwordChangedNotifier } from "../lib/password-changed-notifier"
import { rateLimit } from "../lib/rate-limiter"

const MINUTE = 60 * 1000

export default defineMiddlewares({
  errorHandler: friendlyErrorHandler,
  routes: [
    {
      // The broker pushes HMAC-signed payment callbacks here. The signature is
      // computed over the exact raw request bytes, so we must preserve the raw
      // body | otherwise the provider verifies the HMAC against an empty string
      // and every callback is rejected as "signature mismatch".
      matcher: "/payments/broker-callback",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      // Sentry signs its ops webhook (hex HMAC-SHA256) over the exact raw
      // request bytes; preserve them for the signature check.
      matcher: "/webhooks/ops/sentry",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      // Vercel signs its deployment webhook (hex HMAC-SHA1) over the exact
      // raw request bytes; preserve them for the signature check.
      matcher: "/webhooks/ops/vercel",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      matcher: "/auth/*",
      middlewares: [
        rateLimit({
          windowMs: 5 * MINUTE,
          max: 10,
          message:
            "Te veel aanmeldpogingen. Probeer het over enkele minuten opnieuw.",
        }),
      ],
    },
    {
      matcher: "/auth/:actor/emailpass/update",
      method: ["POST"],
      middlewares: [passwordChangedNotifier()],
    },
    {
      matcher: "/admin/*",
      middlewares: [
        rateLimit({
          windowMs: MINUTE,
          max: 60,
        }),
      ],
    },
    {
      matcher: "/store/*",
      middlewares: [
        rateLimit({
          windowMs: MINUTE,
          max: 120,
        }),
      ],
    },
    {
      // @InovixOpsBot's username is public and searchable, so anyone can DM it
      // and make Telegram deliver an update here | with a valid secret header,
      // because Telegram is the one calling. The allowlist gate in the router
      // stops the command from running, but each delivery still costs an
      // outbound send and a DB write, so cap the volume too. Nothing
      // operator-critical rides this route: order/stock/deploy pushes are
      // outbound from subscribers and jobs, and Telegram redelivers whatever
      // we answer 429 to.
      matcher: "/webhooks/telegram",
      methods: ["POST"],
      middlewares: [
        rateLimit({
          windowMs: MINUTE,
          max: 60,
        }),
      ],
    },
    {
      // Live parcel tracking for the account order page: customers only, and
      // the route itself re-checks the order belongs to the caller.
      matcher: "/store/orders/:id/dhl-tracking",
      method: ["GET"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
  ],
})
