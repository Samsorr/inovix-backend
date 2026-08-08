import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

// Sent-email visibility + resend for one order, shared by the admin
// notifications route and the Telegram bot. Notifications are not directly
// linked to orders, so we match on the order's email address (same approach
// the admin widget has used since the DHL work).

export type OrderEmail = {
  id: string
  template: string
  to: string
  status: string | null
  created_at: string | Date | null
  idempotency_key: string | null
}

export async function listOrderEmails(
  container: MedusaContainer,
  orderId: string
): Promise<{ email: string | null; notifications: OrderEmail[] }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const notificationService: any = container.resolve(Modules.NOTIFICATION)

  const { data: orders } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: ["id", "email"],
  })
  const email = orders?.[0]?.email
  if (!email) return { email: null, notifications: [] }

  const notifications: any[] = await notificationService.listNotifications(
    { to: email },
    { take: 100, order: { created_at: "DESC" } }
  )
  return {
    email,
    notifications: notifications.map((n) => ({
      id: n.id,
      template: n.template,
      to: n.to,
      status: n.status ?? null,
      created_at: n.created_at ?? null,
      idempotency_key: n.idempotency_key ?? null,
    })),
  }
}

export async function getNotification(
  container: MedusaContainer,
  notificationId: string
): Promise<OrderEmail | null> {
  const notificationService: any = container.resolve(Modules.NOTIFICATION)
  const [n] = await notificationService.listNotifications({ id: notificationId })
  if (!n) return null
  return {
    id: n.id,
    template: n.template,
    to: n.to,
    status: n.status ?? null,
    created_at: n.created_at ?? null,
    idempotency_key: n.idempotency_key ?? null,
  }
}

export type ResendResult = { ok: true; template: string; to: string } | { ok: false; reason: "not_found" | "error"; message?: string }

// Re-send with a UNIQUE idempotency key. The original static key would make
// the notification module skip an already-sent email; a fresh key forces a
// real re-send of the same template + data to the same recipient.
//
// The send is awaited and the provider now throws on a Resend rejection, so a
// failure here surfaces as ok:false instead of a green toast over a dropped
// email.
export async function resendOrderEmail(
  container: MedusaContainer,
  notificationId: string
): Promise<ResendResult> {
  const notificationService: any = container.resolve(Modules.NOTIFICATION)
  const [orig] = await notificationService.listNotifications({ id: notificationId })
  if (!orig) return { ok: false, reason: "not_found" }
  try {
    await notificationService.createNotifications({
      to: orig.to,
      channel: orig.channel ?? "email",
      template: orig.template,
      data: orig.data ?? {},
      // Carry the resource over so a resent mail stays attributable to its
      // order (it used to be dropped, which made resends unauditable).
      ...(orig.resource_id ? { resource_id: orig.resource_id } : {}),
      ...(orig.resource_type ? { resource_type: orig.resource_type } : {}),
      trigger_type: "admin.resend",
      original_notification_id: orig.id,
      idempotency_key: `${orig.idempotency_key ?? orig.id}-resend-${Date.now()}`,
    })
    return { ok: true, template: orig.template, to: orig.to }
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message }
  }
}

export type ResendConfirmationResult = {
  ok: boolean
  /** True when an existing confirmation was really re-sent. */
  resent?: boolean
  /** True when no confirmation existed and order.placed was re-emitted. */
  emitted?: boolean
  to?: string
  reason?: "error"
  message?: string
}

// Operator action: "stuur de bestelbevestiging opnieuw".
//
// Re-emitting `order.placed` does NOT work as a resend: the subscriber reuses
// `order-confirmed-<orderId>`, so the notification module skips it and the
// route answered `{ ok: true }` over nothing. When a confirmation row exists we
// replay it under a unique key (a real second email). Only when the order never
// got one do we fall back to emitting the event, which is the correct way to
// produce a first confirmation.
export async function resendOrderConfirmation(
  container: MedusaContainer,
  orderId: string
): Promise<ResendConfirmationResult> {
  const notificationService: any = container.resolve(Modules.NOTIFICATION)

  let existing: any[] = []
  try {
    existing = await notificationService.listNotifications(
      { resource_id: orderId, template: "order-placed" },
      { take: 50, order: { created_at: "DESC" } }
    )
  } catch {
    existing = []
  }

  // Prefer a row that actually reached the customer.
  const successful = (existing ?? []).filter(
    (n: any) => String(n?.status ?? "").toLowerCase() === "success"
  )
  const source = successful[0] ?? existing?.[0]

  if (source) {
    const r = await resendOrderEmail(container, source.id)
    if (r.ok) return { ok: true, resent: true, to: r.to }
    const failure = r as { reason?: "not_found" | "error"; message?: string }
    return { ok: false, reason: "error", message: failure.message }
  }

  try {
    const eventBus: any = container.resolve(Modules.EVENT_BUS)
    await eventBus.emit({ name: "order.placed", data: { id: orderId } })
    return { ok: true, emitted: true }
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message }
  }
}
