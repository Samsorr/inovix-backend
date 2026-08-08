import crypto from 'crypto'
import { POST, parseSentryTime, sentryDedupKey } from '../route'

const SECRET = 'sentry-shared-secret'

// 2026-08-08T14:31:00Z as Sentry sends it: float unix SECONDS.
const EVENT_TS = Date.parse('2026-08-08T14:31:00.000Z') / 1000

const FIXTURE = {
  action: 'triggered',
  data: {
    event: {
      title: 'TypeError: x is not a function',
      culprit: 'app/checkout/route',
      web_url: 'https://inovix.sentry.io/issues/4508123/events/abc/',
      issue_id: '4508123',
      event_id: 'abc',
      timestamp: EVENT_TS,
    },
  },
}

const makeRes = () => {
  const res: any = { statusCode: 0 }
  res.status = jest.fn((c: number) => ((res.statusCode = c), res))
  res.json = jest.fn(() => res)
  res.sendStatus = jest.fn((c: number) => ((res.statusCode = c), res))
  return res
}

// Stand-in for the real notify(): the unique index on `key` means a second
// claim of the same key returns false WITHOUT sending. `delivered` is what the
// operator's phone actually shows.
const claimed = new Set<string>()
const delivered: string[] = []
const notify = jest.fn(async (key: string, _kind: string, text: string) => {
  if (claimed.has(key)) return false
  claimed.add(key)
  delivered.push(text)
  return true
})
const touchEvent = jest.fn().mockResolvedValue(undefined)

const makeReq = (body: unknown, signature: string | undefined) => {
  const raw = Buffer.from(JSON.stringify(body))
  return {
    headers: signature === undefined ? {} : { 'sentry-hook-signature': signature },
    rawBody: raw,
    body,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === 'telegram_ops') return { notify, touchEvent }
        if (key === 'logger') return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        return undefined
      }),
    },
  }
}

const sign = (body: unknown, secret: string) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(JSON.stringify(body))).digest('hex')

describe('POST /webhooks/ops/sentry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claimed.clear()
    delivered.length = 0
    process.env.SENTRY_WEBHOOK_SECRET = SECRET
  })
  afterAll(() => {
    delete process.env.SENTRY_WEBHOOK_SECRET
  })

  it('accepts a valid HMAC, answers 200, and notifies with the dedup key', async () => {
    const res = makeRes()
    await POST(makeReq(FIXTURE, sign(FIXTURE, SECRET)) as any, res)
    expect(res.statusCode).toBe(200)
    expect(notify).toHaveBeenCalledTimes(1)
    const [key, kind, text] = notify.mock.calls[0]
    // issue id + the UTC hour the event happened in, not the bare issue id.
    expect(key).toBe('tg-sentry-4508123-2026-08-08T14')
    expect(kind).toBe('ops_sentry')
    expect(text).toContain('🐞')
    expect(text).toContain('TypeError: x is not a function')
    expect(text).toContain('app/checkout/route')
    expect(text).toContain('https://inovix.sentry.io/issues/4508123/events/abc/')
    expect(touchEvent).toHaveBeenCalledWith(
      'tg-opsstate-sentry',
      'ops_state',
      expect.objectContaining({ payload: expect.objectContaining({ title: 'TypeError: x is not a function' }) })
    )
  })

  it('falls back to data.issue.id for the key', async () => {
    const body = { action: 'created', data: { issue: { id: '999', title: 'Boom', lastSeen: '2026-08-08T09:05:00.000Z' } } }
    const res = makeRes()
    await POST(makeReq(body, sign(body, SECRET)) as any, res)
    expect(res.statusCode).toBe(200)
    expect(notify.mock.calls[0][0]).toBe('tg-sentry-999-2026-08-08T09')
    expect(notify.mock.calls[0][2]).toContain('Boom')
  })

  // The two halves of the dedup contract. Before the fix the key was the bare
  // issue id, so the first assertion passed and the second could never hold:
  // a recurring or regressed error alerted exactly once in its lifetime and
  // /status reported "Sentry (24h): 0" while the site was on fire.
  it('a duplicate delivery of the same event does not double-alert', async () => {
    await POST(makeReq(FIXTURE, sign(FIXTURE, SECRET)) as any, makeRes())
    // Sentry retry, or a second alert rule matching the same event.
    await POST(makeReq(FIXTURE, sign(FIXTURE, SECRET)) as any, makeRes())

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0][0]).toBe(notify.mock.calls[1][0])
    expect(delivered).toHaveLength(1)
  })

  it('dedupes a retry that lands in a later hour, because the bucket comes from the event time', async () => {
    // Same event, processed twice with wall-clock an hour apart: the bucket is
    // derived from data.event.timestamp, so it is identical either way.
    expect(sentryDedupKey(FIXTURE, new Date('2026-08-08T14:59:00Z'))).toBe(
      sentryDedupKey(FIXTURE, new Date('2026-08-08T15:01:00Z'))
    )
  })

  it('a genuine recurrence in a later hour alerts again', async () => {
    const later = {
      ...FIXTURE,
      data: {
        event: {
          ...FIXTURE.data.event,
          event_id: 'def',
          // Same issue, one hour later: a re-fire of the alert rule, or a
          // regression after the issue was resolved.
          timestamp: EVENT_TS + 3600,
          web_url: 'https://inovix.sentry.io/issues/4508123/events/def/',
        },
      },
    }
    await POST(makeReq(FIXTURE, sign(FIXTURE, SECRET)) as any, makeRes())
    await POST(makeReq(later, sign(later, SECRET)) as any, makeRes())

    expect(notify.mock.calls.map((c) => c[0])).toEqual([
      'tg-sentry-4508123-2026-08-08T14',
      'tg-sentry-4508123-2026-08-08T15',
    ])
    expect(delivered).toHaveLength(2)
  })

  it('caps a burst at one alert per issue per hour', async () => {
    for (let i = 0; i < 20; i++) {
      const burst = {
        ...FIXTURE,
        data: { event: { ...FIXTURE.data.event, event_id: `e${i}`, timestamp: EVENT_TS + i } },
      }
      await POST(makeReq(burst, sign(burst, SECRET)) as any, makeRes())
    }
    expect(delivered).toHaveLength(1)
  })

  it('falls back to receipt time when the payload carries no usable timestamp', async () => {
    const body = { action: 'created', data: { issue: { id: '42', title: 'No time here' } } }
    expect(sentryDedupKey(body, new Date('2026-08-08T14:31:00Z'))).toBe('tg-sentry-42-2026-08-08T14')
  })

  it('parses the timestamp shapes Sentry sends', () => {
    expect(parseSentryTime(EVENT_TS)?.toISOString()).toBe('2026-08-08T14:31:00.000Z')
    expect(parseSentryTime(String(EVENT_TS))?.toISOString()).toBe('2026-08-08T14:31:00.000Z')
    expect(parseSentryTime('2026-08-08T14:31:00.000Z')?.toISOString()).toBe('2026-08-08T14:31:00.000Z')
    expect(parseSentryTime(EVENT_TS * 1000)?.toISOString()).toBe('2026-08-08T14:31:00.000Z')
    expect(parseSentryTime('not a date')).toBeNull()
    expect(parseSentryTime(0)).toBeNull()
    expect(parseSentryTime(null)).toBeNull()
    expect(parseSentryTime({})).toBeNull()
  })

  it('rejects a wrong signature with 401 and does not process', async () => {
    const res = makeRes()
    await POST(makeReq(FIXTURE, sign(FIXTURE, 'wrong-secret')) as any, res)
    expect(res.statusCode).toBe(401)
    expect(notify).not.toHaveBeenCalled()
    expect(touchEvent).not.toHaveBeenCalled()
  })

  it('rejects a missing signature header with 401', async () => {
    const res = makeRes()
    await POST(makeReq(FIXTURE, undefined) as any, res)
    expect(res.statusCode).toBe(401)
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects when no secret is configured', async () => {
    delete process.env.SENTRY_WEBHOOK_SECRET
    const res = makeRes()
    await POST(makeReq(FIXTURE, sign(FIXTURE, SECRET)) as any, res)
    expect(res.statusCode).toBe(401)
    expect(notify).not.toHaveBeenCalled()
  })

  it('answers 200 on an unknown payload shape without notifying', async () => {
    const body = { hello: 'world' }
    const res = makeRes()
    await POST(makeReq(body, sign(body, SECRET)) as any, res)
    expect(res.statusCode).toBe(200)
    expect(notify).not.toHaveBeenCalled()
  })
})
