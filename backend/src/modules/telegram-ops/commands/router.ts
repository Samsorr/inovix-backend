import type { MedusaContainer } from '@medusajs/framework/types'
import type TelegramOpsService from '../service'
import { TELEGRAM_OPS_MODULE } from '../index'
import { escapeHtml } from '../format'
import { helpText } from './help'
import { ordersCommand } from './orders'
import { orderDetailCommand } from './order-detail'
import { todoCommand } from './todo'
import { stockCommand } from './stock'
import { findCommand } from './find'
import { salesCommand } from './sales'
import { restockCommand } from './restock'
import { logCommand } from './log'
import { stationCommand } from './station'
import { digestCommand } from './digest'
import { statusCommand } from './status'
import { topCommand } from './top'
import { customerCommand } from './customer'
import { visitorsCommand } from './visitors'
import { CallbackQuery, handleCallback } from './callbacks'
import { CommandReply, normalizeReply } from './reply'
import '../actions' // registers lbl/lblo/shp/shpc/rst into CALLBACKS

export { normalizeReply } from './reply'
export type { CommandReply } from './reply'

export type TelegramUpdate = {
  message?: {
    chat: { id: number | string }
    from?: { id: number | string; first_name?: string; username?: string }
    text?: string
  }
  callback_query?: CallbackQuery
}

export type CommandCtx = {
  container: MedusaContainer
  svc: TelegramOpsService
  chatId: string
  args: string[]
}

export type CommandHandler = (ctx: CommandCtx) => Promise<CommandReply>

type OpsLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text?.startsWith('/')) return null
  const [head, ...args] = text.trim().split(/\s+/)
  const command = head.slice(1).split('@')[0].toLowerCase()
  if (!command) return null
  return { command, args }
}

export const COMMANDS: Record<string, CommandHandler> = {
  help: async () => helpText(),
  start: async () => helpText(),
  orders: ordersCommand,
  order: orderDetailCommand,
  todo: todoCommand,
  stock: stockCommand,
  find: findCommand,
  sales: salesCommand,
  restock: restockCommand,
  log: logCommand,
  station: stationCommand,
  digest: digestCommand,
  status: statusCommand,
  top: topCommand,
  customer: customerCommand,
  visitors: visitorsCommand,
}

export async function handleUpdate(container: MedusaContainer, update: TelegramUpdate): Promise<void> {
  const svc = container.resolve(TELEGRAM_OPS_MODULE) as TelegramOpsService
  const logger = container.resolve('logger') as OpsLogger

  // Button taps arrive as callback_query updates. Allowlist is enforced the
  // same way as for messages; the callback is ALWAYS answered so the client
  // spinner stops, but non-allowlisted taps do nothing.
  const cb = update.callback_query
  if (cb) {
    const cbChatId = String(cb.message?.chat.id ?? '')
    let toast: string | undefined
    if (!svc.allowedChatIds().includes(cbChatId)) {
      logger.warn(`telegram-ops: ignored callback from non-allowlisted chat ${cbChatId}`)
    } else {
      try {
        const t = await handleCallback(container, svc, cb)
        if (typeof t === 'string') toast = t
      } catch (e) {
        logger.error(`telegram-ops: callback ${cb.data ?? '?'} failed: ${(e as Error).message}`)
        toast = 'Action failed. Check the logs.'
      }
    }
    await svc.answerCallback(cb.id, toast)
    return
  }

  const msg = update.message
  if (!msg?.text) return
  const chatId = String(msg.chat.id)
  const allowed = svc.allowedChatIds()

  // Bootstrap mode: no allowlist configured yet. Reply with the chat id so
  // the operator can put it in TELEGRAM_ALLOWED_CHAT_IDS, and do NOTHING else.
  if (allowed.length === 0) {
    await svc.sendTo(chatId, `Your chat id is <b>${chatId}</b>. Add it to TELEGRAM_ALLOWED_CHAT_IDS to activate the bot.`)
    return
  }

  if (!allowed.includes(chatId)) {
    logger.warn(`telegram-ops: refused update from non-allowlisted chat ${chatId}`)
    // ONE notification to the operator per unknown chat (notify dedups on the
    // key) so a friend who should get access can be added to
    // TELEGRAM_ALLOWED_CHAT_IDS, and the polite refusal (spec 2.2) rides the
    // SAME dedup: it goes out only on genuine first contact.
    //
    // Replying to every message would let anyone who knows the public bot
    // username drive unbounded outbound sends (3 attempts each). Past
    // Telegram's ~30 msg/s ceiling the bot starts getting 429s, and because
    // notify() claims its key before sending, a real "New order" push landing
    // in that window is dropped permanently | the operator never learns a paid
    // order arrived. So the stranger path must cost at most one send, ever.
    const from = msg.from
    const who = [from?.first_name, from?.username ? `@${from.username}` : null].filter(Boolean).join(' ')
    const firstContact = await svc.notify(
      `tg-stranger-${chatId}`,
      'stranger',
      `👋 Chat <b>${escapeHtml(chatId)}</b>${who ? ` (${escapeHtml(who)})` : ''} tried to use the bot. To grant access, add the id to TELEGRAM_ALLOWED_CHAT_IDS on Railway.`,
      {}
    )
    if (firstContact) {
      await svc.sendTo(chatId, 'This is a private bot for the shop operator. Access requests go to the owner.')
    }
    return
  }

  const parsed = parseCommand(msg.text)
  if (!parsed) {
    await svc.sendTo(chatId, 'I only speak commands. Try /help.')
    return
  }

  const handler = COMMANDS[parsed.command]
  if (!handler) {
    await svc.sendTo(chatId, `Unknown command /${parsed.command}. Try /help.`)
    return
  }

  try {
    const reply = await handler({ container, svc, chatId, args: parsed.args })
    const { text, extra } = normalizeReply(reply)
    await svc.sendTo(chatId, text, extra)
  } catch (e) {
    logger.error(`telegram-ops: /${parsed.command} failed: ${(e as Error).message}`)
    await svc.sendTo(chatId, `Something went wrong running /${parsed.command}. Check the logs.`)
  }
}
