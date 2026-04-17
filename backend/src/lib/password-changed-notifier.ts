import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"
import type {
  INotificationModuleService,
  Logger,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { EmailTemplates } from "../modules/email-notifications/templates"
import { Sentry } from "./instrument"

function formatDateNL(date: Date): string {
  try {
    return new Intl.DateTimeFormat("nl-NL", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Amsterdam",
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

function formatDateEN(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Amsterdam",
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

function resolveActorType(url: string): "customer" | "user" | null {
  if (url.includes("/auth/customer/")) return "customer"
  if (url.includes("/auth/user/")) return "user"
  return null
}

export function passwordChangedNotifier() {
  return function passwordChangedMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const actorType = resolveActorType(req.originalUrl || req.url || "")
    if (!actorType) return next()

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return

      const authCtx = (req as unknown as { auth_context?: { actor_id?: string } })
        .auth_context
      const recipient =
        authCtx?.actor_id ??
        (req.body as { email?: unknown } | undefined)?.email
      if (typeof recipient !== "string" || !recipient.includes("@")) return

      const now = new Date()
      const supportEmail =
        process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL || undefined
      const isCustomer = actorType === "customer"
      const changedAt = isCustomer ? formatDateNL(now) : formatDateEN(now)
      const subject = isCustomer
        ? "Uw Inovix-wachtwoord is gewijzigd"
        : "Your Inovix admin password was changed"
      const textBody = isCustomer
        ? `Uw Inovix-wachtwoord is zojuist gewijzigd op ${changedAt}.\n\n` +
          `Was u dit niet? Neem direct contact met ons op${
            supportEmail ? ` via ${supportEmail}` : ""
          } en wijzig uw wachtwoord zo snel mogelijk.`
        : `Your Inovix admin password was just changed at ${changedAt}.\n\n` +
          `Was this not you? Contact us immediately${
            supportEmail ? ` at ${supportEmail}` : ""
          } and change your password right away.`

      ;(async () => {
        try {
          const notificationModuleService: INotificationModuleService =
            req.scope.resolve(Modules.NOTIFICATION)
          await notificationModuleService.createNotifications({
            to: recipient,
            channel: "email",
            template: EmailTemplates.PASSWORD_CHANGED,
            data: {
              emailOptions: {
                subject,
                text: textBody,
                ...(supportEmail ? { replyTo: supportEmail } : {}),
              },
              actorType,
              changedAt,
              ...(supportEmail ? { supportEmail } : {}),
            },
          })
        } catch (error) {
          const logger: Logger = req.scope.resolve("logger")
          logger.error(
            `password-changed-notifier: failed to send confirmation to ${recipient}: ${
              (error as Error).message
            }`
          )
          Sentry.captureException(error, {
            tags: { middleware: "password-changed-notifier", actor_type: actorType },
          })
        }
      })()
    })

    next()
  }
}
