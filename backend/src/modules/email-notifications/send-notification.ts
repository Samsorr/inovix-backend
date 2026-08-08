import type {
  CreateNotificationDTO,
  INotificationModuleService,
  Logger,
  MedusaContainer,
} from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'

import { Sentry } from '../../lib/instrument'

/**
 * Idempotency-aware wrapper around `notificationModuleService.createNotifications`.
 *
 * Why this exists
 * ---------------
 * Medusa's notification module dedups on `idempotency_key`, but its retry
 * branch is broken. `createNotifications_` re-processes an entry whose stored
 * row is `status: failure`, then rebuilds it with a FRESHLY GENERATED id while
 * `toCreate` filters the insert out (the key already exists). The email is
 * therefore sent against a phantom id and the trailing
 * `notificationService_.update()` throws NOT_FOUND. Net effect: the mail goes
 * out, the call throws, the row stays `failure` forever, and every subsequent
 * trigger sends yet another copy while reporting failure. Unbounded duplicates.
 *
 * So we never hand Medusa a key that already exists. We own the retry:
 *
 * - success on any attempt key  -> skip. A genuine success can never double-send.
 * - a fresh `pending` row       -> skip. Another worker is mid-flight.
 * - failure (or a stale pending, i.e. a process that died mid-send)
 *                               -> send again under the NEXT attempt key.
 *
 * A failure therefore does NOT consume the idempotency key: the base key is
 * spent, but `<base>-retry-1` and `<base>-retry-2` are still available, so the
 * next trigger (payment.captured after order.placed, the auto-mark-shipped
 * cron, an operator resend) actually re-sends. That is deliberate at-least-once
 * delivery: for transactional email a missing order confirmation is far worse
 * than a duplicate. It cannot loop unboundedly because the ladder is finite |
 * MAX_EMAIL_ATTEMPTS keys and then we stop and shout.
 */

/** Total sends allowed per logical email: the base key plus 2 retry keys. */
export const MAX_EMAIL_ATTEMPTS = 3

/**
 * A `pending` row older than this is assumed to be a crashed send rather than
 * an in-flight one, and becomes retryable. Medusa never resets pending rows.
 */
export const STALE_PENDING_MS = 10 * 60 * 1000

export type ExistingNotificationRow = {
  id: string
  idempotency_key?: string | null
  status?: string | null
  created_at?: string | Date | null
}

export type EmailSkipReason = 'already_sent' | 'in_flight' | 'retry_budget_exhausted'

/**
 * Flat shape on purpose: this repo's tsconfig runs without strict mode, which
 * breaks negative-branch narrowing on discriminated unions.
 */
export type EmailSendPlan = {
  send: boolean
  idempotency_key: string
  /** 1-based attempt number. Only meaningful when `send` is true. */
  attempt: number
  /** The first row seen for this logical email, for `original_notification_id`. */
  original_notification_id: string | null
  reason?: EmailSkipReason
}

export type EmailSendOutcome = {
  sent: boolean
  attempt: number
  idempotency_key: string | null
  reason?: EmailSkipReason
}

/** The finite ladder of keys one logical email may occupy. */
export function attemptKeys(baseKey: string): string[] {
  const keys = [baseKey]
  for (let i = 1; i < MAX_EMAIL_ATTEMPTS; i++) {
    keys.push(`${baseKey}-retry-${i}`)
  }
  return keys
}

/** Pure decision function, exported for tests. */
export function planEmailSend(
  baseKey: string,
  rows: (ExistingNotificationRow | null | undefined)[],
  now: number = Date.now()
): EmailSendPlan {
  const byKey = new Map<string, ExistingNotificationRow>()
  for (const row of rows ?? []) {
    if (row?.idempotency_key) byKey.set(row.idempotency_key, row)
  }

  const keys = attemptKeys(baseKey)
  let originalId: string | null = null

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const row = byKey.get(key)

    if (!row) {
      return {
        send: true,
        idempotency_key: key,
        attempt: i + 1,
        original_notification_id: originalId,
      }
    }

    if (originalId == null) originalId = row.id

    const status = String(row.status ?? '').toLowerCase()

    if (status === 'success') {
      return {
        send: false,
        idempotency_key: key,
        attempt: i + 1,
        original_notification_id: originalId,
        reason: 'already_sent',
      }
    }

    if (status === 'pending') {
      const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0
      const age = now - (Number.isFinite(createdAt) ? createdAt : 0)
      if (age < STALE_PENDING_MS) {
        return {
          send: false,
          idempotency_key: key,
          attempt: i + 1,
          original_notification_id: originalId,
          reason: 'in_flight',
        }
      }
      // Stale pending: the sender died between INSERT and the status update.
      // Fall through and retry under the next key.
    }

    // `failure` (or stale `pending`): try the next rung of the ladder.
  }

  return {
    send: false,
    idempotency_key: keys[keys.length - 1],
    attempt: keys.length,
    original_notification_id: originalId,
    reason: 'retry_budget_exhausted',
  }
}

/**
 * Create a notification, honouring the idempotency key without ever handing
 * Medusa a key that already exists.
 *
 * Throws when the underlying send fails, so the caller's catch + Sentry capture
 * fires and the row is left at `status: failure` (retryable via the next key).
 */
export async function sendEmailNotification(
  container: MedusaContainer,
  input: CreateNotificationDTO
): Promise<EmailSendOutcome> {
  const notificationModuleService = container.resolve(
    Modules.NOTIFICATION
  ) as INotificationModuleService & {
    listNotifications: (filters?: any, config?: any) => Promise<any[]>
  }
  const logger = container.resolve('logger') as Logger

  const baseKey = input.idempotency_key

  // No key means the caller deliberately wants every trigger to send
  // (password reset, invites). Nothing to dedup.
  if (!baseKey) {
    await notificationModuleService.createNotifications(input)
    return { sent: true, attempt: 1, idempotency_key: null }
  }

  const keys = attemptKeys(baseKey)
  const rows = await notificationModuleService.listNotifications({
    idempotency_key: keys,
  })

  const plan = planEmailSend(baseKey, rows ?? [])

  if (!plan.send) {
    if (plan.reason === 'retry_budget_exhausted') {
      const message =
        `email "${input.template}" to ${input.to} exhausted its retry budget ` +
        `(${MAX_EMAIL_ATTEMPTS} attempts on "${baseKey}"); giving up`
      logger.error(`send-notification: ${message}`)
      Sentry.captureMessage(message, {
        level: 'error',
        tags: { area: 'email', template: String(input.template ?? 'unknown') },
        extra: { idempotency_key: baseKey, to: input.to },
      })
    } else {
      logger.info(
        `send-notification: skipping "${input.template}" to ${input.to} (${plan.reason}, key ${plan.idempotency_key})`
      )
    }
    return {
      sent: false,
      attempt: plan.attempt,
      idempotency_key: plan.idempotency_key,
      reason: plan.reason,
    }
  }

  if (plan.attempt > 1) {
    logger.info(
      `send-notification: retrying "${input.template}" to ${input.to} as attempt ${plan.attempt}/${MAX_EMAIL_ATTEMPTS} (key ${plan.idempotency_key})`
    )
  }

  await notificationModuleService.createNotifications({
    ...input,
    idempotency_key: plan.idempotency_key,
    ...(plan.original_notification_id
      ? { original_notification_id: plan.original_notification_id }
      : {}),
  })

  return {
    sent: true,
    attempt: plan.attempt,
    idempotency_key: plan.idempotency_key,
  }
}
