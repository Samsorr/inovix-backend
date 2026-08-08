import type { MedusaContainer } from '@medusajs/framework/types'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import type TelegramOpsService from '../../../../modules/telegram-ops/service'
import { escapeHtml } from '../../../../modules/telegram-ops/format'
import { Sentry } from '../../../../lib/instrument'
import { hmacHex, safeEqualHex } from '../verify'

// Sentry issue-alert webhook -> Telegram ops feed (N12). Sentry signs the RAW
// request body with hex HMAC-SHA256 in `sentry-hook-signature`; the raw body
// is preserved via src/api/middlewares.ts. 401 BEFORE parsing on bad auth,
// 200 BEFORE async processing (mirrors src/api/webhooks/telegram/route.ts).

type SentryWebhookBody = {
  data?: {
    event?: {
      title?: string
      culprit?: string | null
      web_url?: string
      url?: string
      issue_id?: string | number
      event_id?: string
      // Sentry sends these as float unix SECONDS on the event_alert payload;
      // `datetime` is the ISO form on some generations.
      timestamp?: number | string
      received?: number | string
      datetime?: string
    }
    issue?: {
      id?: string | number
      title?: string
      culprit?: string | null
      web_url?: string
      lastSeen?: string
    }
  }
}

/**
 * Parse the timestamp shapes Sentry actually sends: float unix SECONDS
 * (data.event.timestamp / received), an ISO string (data.event.datetime,
 * data.issue.lastSeen), or a numeric string. Returns null on anything else.
 */
export function parseSentryTime(v: unknown): Date | null {
  if (v == null) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    // Seconds vs milliseconds: Sentry uses seconds, but be tolerant.
    const d = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return null
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseSentryTime(Number(trimmed))
    const d = new Date(trimmed)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * The notify() dedup key for one Sentry delivery.
 *
 * WHY NOT the bare issue id (the bug this replaces): `data.issue.id` /
 * `data.event.issue_id` is stable for the whole lifetime of an error
 * signature, so notify() claimed it once and every later delivery for that
 * issue | a re-fire of the alert rule, a regression after "resolved", a
 * two-day burst | was swallowed. /status then reported "Sentry (24h): 0"
 * because it counts exactly those rows.
 *
 * WHY NOT the per-delivery event id alone: `data.event.event_id` is absent
 * from the `issue` resource payloads (which carry only `data.issue`), and it
 * removes every local brake | a bursting issue would push one Telegram
 * message per delivery, with the only rate limit being the alert rule's
 * "frequency" setting in the Sentry dashboard, which is not visible from or
 * controlled by this code.
 *
 * So: issue id + the UTC hour the EVENT happened in. A duplicate delivery
 * (a retry after a 5xx, or two alert rules matching the same event) computes
 * the same bucket and is dropped. A recurrence an hour later, or a
 * regression days later, lands in a new bucket and alerts. The ceiling is one
 * message per issue per hour, and the ops_sentry rows /status counts finally
 * mean "issue-hours that actually burned".
 *
 * The bucket is derived from the payload's own timestamp rather than from
 * receipt time on purpose: a retried delivery then dedupes even when the
 * retry lands on the other side of an hour boundary.
 */
export function sentryDedupKey(body: SentryWebhookBody, receivedAt: Date): string | null {
  const event = body?.data?.event
  const issue = body?.data?.issue
  const id = issue?.id ?? event?.issue_id ?? event?.event_id
  if (id == null || id === '') return null

  const at =
    parseSentryTime(event?.timestamp) ??
    parseSentryTime(event?.received) ??
    parseSentryTime(event?.datetime) ??
    parseSentryTime(issue?.lastSeen) ??
    receivedAt
  // "2026-08-08T14" | UTC hour bucket.
  const bucket = at.toISOString().slice(0, 13)
  return `tg-sentry-${id}-${bucket}`
}

async function processSentryEvent(scope: MedusaContainer, body: SentryWebhookBody): Promise<void> {
  const svc = scope.resolve('telegram_ops') as TelegramOpsService
  const logger = scope.resolve('logger') as { warn: (m: string) => void }

  const event = body?.data?.event
  const issue = body?.data?.issue
  const title = event?.title ?? issue?.title
  const key = sentryDedupKey(body, new Date())
  if (!title || !key) {
    logger.warn('telegram-ops: sentry webhook with unrecognized shape, skipped')
    return
  }

  const culprit = event?.culprit ?? issue?.culprit
  const link = event?.web_url ?? event?.url ?? issue?.web_url
  const lines = [`🐞 <b>Sentry: ${escapeHtml(title)}</b>`]
  if (culprit) lines.push(`Culprit: ${escapeHtml(culprit)}`)
  if (link) lines.push(escapeHtml(link))

  await svc.notify(key, 'ops_sentry', lines.join('\n'))
  await svc.touchEvent('tg-opsstate-sentry', 'ops_state', {
    sent_at: new Date(),
    payload: { title, at: new Date().toISOString() },
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const secret = process.env.SENTRY_WEBHOOK_SECRET ?? ''
  const signature = req.headers['sentry-hook-signature']
  const raw = (req.rawBody as Buffer | undefined) ?? Buffer.alloc(0)

  if (!secret || typeof signature !== 'string' || !safeEqualHex(signature, hmacHex('sha256', secret, raw))) {
    res.sendStatus(401)
    return
  }

  // Acknowledge before processing: a slow Telegram send must never make
  // Sentry retry (and double-notify).
  res.sendStatus(200)

  try {
    await processSentryEvent(req.scope, (req.body ?? {}) as SentryWebhookBody)
  } catch (e) {
    Sentry.captureException(e, { tags: { route: 'webhooks/ops/sentry' } })
  }
}
