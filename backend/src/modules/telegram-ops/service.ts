import { MedusaService } from '@medusajs/framework/utils'
import { TelegramOpsEvent } from './models/ops-event-log'
import { sendTelegramRequest } from './telegram-client'
import { Sentry } from '../../lib/instrument'

export type TelegramOpsOptions = {
  botToken?: string
  webhookSecret?: string
  allowedChatIds?: string
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string }
  return (
    err?.name === 'UniqueConstraintViolationException' ||
    err?.code === '23505' ||
    // Medusa's dbErrorMapper rewraps the Postgres 23505 into a MedusaError
    // (type invalid_data, message "<Entity> with key: <k>, already exists.")
    // before it reaches our catch, so match the mapped message too. Callers
    // only use this around a create, where "already exists" is always a dup.
    /unique|duplicate|already exists/i.test(err?.message ?? '')
  )
}

class TelegramOpsService extends MedusaService({ TelegramOpsEvent }) {
  protected options_: TelegramOpsOptions
  protected logger_: { error?: (...args: unknown[]) => void } | undefined

  constructor(container: Record<string, unknown>, options: TelegramOpsOptions = {}) {
    super(...arguments)
    this.options_ = options
    this.logger_ = (container as { logger?: { error?: (...args: unknown[]) => void } })?.logger
  }

  botToken(): string {
    return this.options_.botToken ?? ''
  }

  webhookSecret(): string {
    return this.options_.webhookSecret ?? ''
  }

  allowedChatIds(): string[] {
    return (this.options_.allowedChatIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  isConfigured(): boolean {
    return Boolean(this.botToken()) && this.allowedChatIds().length > 0
  }

  async sendTo(chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.botToken()) return
    const res = await sendTelegramRequest(this.botToken(), 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    })
    if (!res.ok) {
      // Never let a failed-send report itself throw: sendTo must never throw,
      // callers treat notifications as fire-and-forget.
      try {
        const message = `telegram-ops: sendMessage to chat ${chatId} failed: ${res.description ?? 'unknown error'}`
        this.logger_?.error?.(message)
        // No message body: text can contain order data, only description + metadata.
        Sentry.captureMessage(message, {
          level: 'warning',
          tags: { module: 'telegram-ops' },
          extra: { chatId, description: res.description ?? null },
        })
      } catch {
        /* logging must never break sendTo */
      }
    }
  }

  async sendToAll(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.isConfigured()) return
    for (const chatId of this.allowedChatIds()) {
      await this.sendTo(chatId, text, extra)
    }
  }

  /**
   * Idempotent notification: claims `key` in telegram_ops_event first
   * (unique index), then sends. A concurrent duplicate (e.g. the
   * order.placed + payment.captured pair) loses the insert race and skips.
   * Claim-then-send means a Telegram outage can drop one message but never
   * double-send; notifications are advisory, orders are the record.
   */
  async notify(key: string, kind: string, text: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await this.createTelegramOpsEvents({ key, kind, sent_at: new Date(), payload: { text } })
    } catch (e) {
      if (isUniqueViolation(e)) return false
      throw e
    }
    await this.sendToAll(text, extra)
    return true
  }

  async editMessage(chatId: string, messageId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.botToken()) return
    // Omitting reply_markup in extra removes any existing inline keyboard.
    const res = await sendTelegramRequest(this.botToken(), 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    })
    if (!res.ok) {
      // Telegram answers 400 "message is not modified" when text and keyboard
      // are already identical (a second tap that re-renders the same view).
      // The message on screen is exactly what was asked for: not a failure,
      // so no log line and no Sentry warning (INOVIX-BACKEND-E).
      if (/message is not modified/i.test(res.description ?? '')) return
      try {
        const message = `telegram-ops: editMessageText in chat ${chatId} failed: ${res.description ?? 'unknown error'}`
        this.logger_?.error?.(message)
        Sentry.captureMessage(message, {
          level: 'warning',
          tags: { module: 'telegram-ops' },
          extra: { chatId, messageId, description: res.description ?? null },
        })
      } catch {
        /* logging must never break editMessage */
      }
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.botToken()) return
    // Best effort: an unanswered callback only leaves a client spinner.
    await sendTelegramRequest(this.botToken(), 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  /**
   * Claim an action key: audit row + double-tap dedup in one insert. Returns
   * false when the key is already claimed. Callers that can fail AFTER a
   * claim call releaseAction so a transient failure stays retryable.
   */
  async claimAction(key: string, kind: string, actor: { id: string; name: string }, payload: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await this.createTelegramOpsEvents({
        key, kind, sent_at: new Date(), payload,
        actor_id: actor.id, actor_name: actor.name,
      })
      return true
    } catch (e) {
      if (isUniqueViolation(e)) return false
      throw e
    }
  }

  async releaseAction(key: string): Promise<void> {
    try {
      const rows = await this.listTelegramOpsEvents({ key })
      const row = (rows as Array<{ id: string }>)[0]
      if (row) await this.deleteTelegramOpsEvents(row.id)
    } catch (e) {
      this.logger_?.error?.(`telegram-ops: releaseAction(${key}) failed: ${(e as Error).message}`)
    }
  }

  /** The event-log row for a key (reminder / stock-crossing state), or null. */
  async findEvent(key: string): Promise<{ id: string; key: string; kind: string; sent_at: Date | string | null; snoozed_until: Date | string | null; payload: Record<string, unknown> | null } | null> {
    const rows = await this.listTelegramOpsEvents({ key })
    return ((rows as never[])[0] as never) ?? null
  }

  /**
   * Upsert reminder/state fields on the row for `key` (creates it when
   * absent). Unlike notify/claimAction this is NOT a dedup primitive: it is
   * how the scheduled jobs track last-send time, snooze, and crossing state.
   */
  async touchEvent(key: string, kind: string, data: { sent_at?: Date; snoozed_until?: Date; payload?: Record<string, unknown> }): Promise<void> {
    const existing = await this.findEvent(key)
    if (existing) {
      await this.updateTelegramOpsEvents({ id: existing.id, ...data })
      return
    }
    await this.createTelegramOpsEvents({ key, kind, ...data })
  }

  async listRecentActions(take: number): Promise<Array<{ kind: string; sent_at: Date | string | null; actor_name: string | null; payload: Record<string, unknown> | null }>> {
    const rows = await this.listTelegramOpsEvents(
      { kind: ['act_label', 'act_ship', 'act_restock', 'act_email'] },
      { take, order: { sent_at: 'DESC' } }
    )
    return rows as never
  }
}

export default TelegramOpsService
