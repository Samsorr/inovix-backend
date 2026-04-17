import { defineMiddlewares } from "@medusajs/framework/http"

import { rateLimit } from "../lib/rate-limiter"

const MINUTE = 60 * 1000

export default defineMiddlewares({
  routes: [
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
  ],
})
