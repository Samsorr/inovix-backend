import { parseCommand, handleUpdate, normalizeReply, COMMANDS } from '../commands/router'

describe('parseCommand', () => {
  it('parses command and args', () => {
    expect(parseCommand('/orders 5')).toEqual({ command: 'orders', args: ['5'] })
    expect(parseCommand('/order 28412')).toEqual({ command: 'order', args: ['28412'] })
  })
  it('strips the @BotName suffix and lowercases', () => {
    expect(parseCommand('/Orders@InovixOpsBot 3')).toEqual({ command: 'orders', args: ['3'] })
  })
  it('returns null for non-commands', () => {
    expect(parseCommand('hello')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })
})

describe('handleUpdate', () => {
  const makeSvc = (chatIds: string[]) => ({
    allowedChatIds: jest.fn(() => chatIds),
    sendTo: jest.fn().mockResolvedValue(undefined),
    notify: jest.fn().mockResolvedValue(true),
  })
  const makeContainer = (svc: unknown) => ({
    resolve: jest.fn((key: string) => {
      if (key === 'telegram_ops') return svc
      if (key === 'logger') return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      return undefined
    }),
  })
  const msgUpdate = (chatId: number, text: string) => ({
    message: { chat: { id: chatId }, from: { id: chatId, first_name: 'Sam' }, text },
  })

  it('answers /help for an allowlisted chat', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, msgUpdate(111, '/help') as any)
    expect(svc.sendTo).toHaveBeenCalledWith('111', expect.stringContaining('/orders'), {})
  })

  it('non-allowlisted chats get a polite refusal, never command output', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, msgUpdate(999, '/help') as any)
    expect(svc.sendTo).toHaveBeenCalledWith('999', expect.stringContaining('private bot'))
    expect(svc.sendTo).not.toHaveBeenCalledWith('999', expect.stringContaining('/orders'))
  })

  it('a stranger is answered only on first contact, so flooding the bot costs no sends', async () => {
    // The bot username is public: anyone can DM it. If every message got a
    // reply, a flood would burn the bot's Telegram quota and a real "New
    // order" notify (whose key is claimed before the send) would be lost for
    // good. notify() returning false means "already seen this chat" | stay
    // silent from then on.
    const svc = makeSvc(['111'])
    svc.notify.mockResolvedValueOnce(true).mockResolvedValue(false)

    await handleUpdate(makeContainer(svc) as any, msgUpdate(999, '/help') as any)
    expect(svc.sendTo).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 25; i++) {
      await handleUpdate(makeContainer(svc) as any, msgUpdate(999, `spam ${i}`) as any)
    }
    expect(svc.sendTo).toHaveBeenCalledTimes(1) // still just the first refusal
    expect(svc.notify).toHaveBeenCalledTimes(26) // dedup key, one row ever
  })

  it('never sends a stranger anything the operator was not also told about', async () => {
    // The refusal must not outrun the notify: if the claim fails the stranger
    // gets nothing, so an attacker can never produce a send we did not intend.
    const svc = makeSvc(['111'])
    svc.notify.mockResolvedValue(false)
    await handleUpdate(makeContainer(svc) as any, msgUpdate(999, '/help') as any)
    expect(svc.sendTo).not.toHaveBeenCalled()
  })

  it('a stranger triggers ONE operator notification with the chat id (dedup key)', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, msgUpdate(999, '/start') as any)
    expect(svc.notify).toHaveBeenCalledWith(
      'tg-stranger-999', 'stranger',
      expect.stringContaining('999'),
      expect.anything()
    )
    const text = (svc.notify as jest.Mock).mock.calls[0][2] as string
    expect(text).toContain('Sam') // first_name helps the operator recognize who
  })

  it('bootstrap mode: empty allowlist replies ONLY with the chat id', async () => {
    const svc = makeSvc([])
    await handleUpdate(makeContainer(svc) as any, msgUpdate(555, '/start') as any)
    expect(svc.sendTo).toHaveBeenCalledTimes(1)
    expect(svc.sendTo).toHaveBeenCalledWith('555', expect.stringContaining('555'))
  })

  it('unknown command answers with help hint', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, msgUpdate(111, '/frobnicate') as any)
    expect(svc.sendTo).toHaveBeenCalledWith('111', expect.stringContaining('/help'))
  })

  it('a handler is looked up in COMMANDS', () => {
    expect(Object.keys(COMMANDS)).toEqual(expect.arrayContaining(['help', 'start']))
  })
})

describe('handleUpdate with callback_query', () => {
  const makeSvc = (chatIds: string[]) => ({
    allowedChatIds: jest.fn(() => chatIds),
    sendTo: jest.fn().mockResolvedValue(undefined),
    editMessage: jest.fn().mockResolvedValue(undefined),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  })
  const makeContainer = (svc: unknown) => ({
    resolve: jest.fn((key: string) => {
      if (key === 'telegram_ops') return svc
      if (key === 'logger') return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      return undefined
    }),
  })
  const cbUpdate = (chatId: number, data: string) => ({
    callback_query: {
      id: 'cbq-1', from: { id: chatId, first_name: 'Sam' },
      message: { message_id: 42, chat: { id: chatId }, text: 'original' }, data,
    },
  })

  it('dispatches and answers the callback for an allowlisted chat', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, cbUpdate(111, 'dis') as any)
    expect(svc.editMessage).toHaveBeenCalled()
    expect(svc.answerCallback).toHaveBeenCalledWith('cbq-1', undefined)
  })

  it('ignores callbacks from non-allowlisted chats but still answers to stop the spinner', async () => {
    const svc = makeSvc(['111'])
    await handleUpdate(makeContainer(svc) as any, cbUpdate(999, 'dis') as any)
    expect(svc.editMessage).not.toHaveBeenCalled()
    expect(svc.answerCallback).toHaveBeenCalledWith('cbq-1', undefined)
  })

  it('a throwing handler answers with a failure toast instead of crashing', async () => {
    const svc = makeSvc(['111'])
    svc.editMessage.mockRejectedValue(new Error('boom'))
    await handleUpdate(makeContainer(svc) as any, cbUpdate(111, 'dis') as any)
    expect(svc.answerCallback).toHaveBeenCalledWith('cbq-1', expect.stringContaining('failed'))
  })
})

describe('normalizeReply', () => {
  it('passes strings through and unwraps reply objects', () => {
    expect(normalizeReply('hi')).toEqual({ text: 'hi', extra: {} })
    const kb = { inline_keyboard: [[{ text: 'x', callback_data: 'det:1' }]] }
    expect(normalizeReply({ text: 'hi', reply_markup: kb })).toEqual({ text: 'hi', extra: { reply_markup: kb } })
    expect(normalizeReply({ text: 'hi' })).toEqual({ text: 'hi', extra: {} })
  })
})
