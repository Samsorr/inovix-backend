jest.mock('../../../lib/instrument', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}))

jest.mock('@medusajs/framework/utils', () => ({
  Modules: { NOTIFICATION: 'notification' },
}))

import {
  MAX_EMAIL_ATTEMPTS,
  STALE_PENDING_MS,
  attemptKeys,
  planEmailSend,
  sendEmailNotification,
} from '../send-notification'
import { Sentry } from '../../../lib/instrument'

const BASE = 'order-confirmed-order_1'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'noti_1',
    idempotency_key: BASE,
    status: 'failure',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeContainer(existing: any[] = []) {
  const listNotifications = jest.fn().mockResolvedValue(existing)
  const createNotifications = jest.fn().mockResolvedValue({})
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }
  const container: any = {
    resolve: (key: string) => {
      if (key === 'notification') return { listNotifications, createNotifications }
      if (key === 'logger') return logger
      throw new Error(`unexpected resolve: ${key}`)
    },
  }
  return { container, listNotifications, createNotifications, logger }
}

describe('attemptKeys', () => {
  it('produces a finite ladder so a retry can never loop forever', () => {
    expect(attemptKeys(BASE)).toEqual([
      BASE,
      `${BASE}-retry-1`,
      `${BASE}-retry-2`,
    ])
    expect(attemptKeys(BASE)).toHaveLength(MAX_EMAIL_ATTEMPTS)
  })
})

describe('planEmailSend', () => {
  it('sends under the base key when nothing exists', () => {
    expect(planEmailSend(BASE, [])).toMatchObject({
      send: true,
      idempotency_key: BASE,
      attempt: 1,
    })
  })

  it('never re-sends a success', () => {
    expect(planEmailSend(BASE, [row({ status: 'success' })])).toMatchObject({
      send: false,
      reason: 'already_sent',
    })
  })

  it('never re-sends a success recorded on a retry key either', () => {
    const rows = [
      row({ id: 'noti_1', status: 'failure' }),
      row({ id: 'noti_2', idempotency_key: `${BASE}-retry-1`, status: 'success' }),
    ]
    expect(planEmailSend(BASE, rows)).toMatchObject({
      send: false,
      reason: 'already_sent',
      idempotency_key: `${BASE}-retry-1`,
    })
  })

  it('skips while another worker is mid-flight (fresh pending)', () => {
    expect(planEmailSend(BASE, [row({ status: 'pending' })])).toMatchObject({
      send: false,
      reason: 'in_flight',
    })
  })

  it('retries a pending row left behind by a crashed sender', () => {
    const stale = row({
      status: 'pending',
      created_at: new Date(Date.now() - STALE_PENDING_MS - 1000).toISOString(),
    })
    expect(planEmailSend(BASE, [stale])).toMatchObject({
      send: true,
      idempotency_key: `${BASE}-retry-1`,
      attempt: 2,
    })
  })

  it('a FAILURE does not consume the key: it retries under the next rung', () => {
    expect(planEmailSend(BASE, [row({ status: 'failure' })])).toMatchObject({
      send: true,
      idempotency_key: `${BASE}-retry-1`,
      attempt: 2,
      original_notification_id: 'noti_1',
    })
  })

  it('walks the whole ladder while every rung has failed', () => {
    const rows = [
      row({ id: 'noti_1', status: 'failure' }),
      row({ id: 'noti_2', idempotency_key: `${BASE}-retry-1`, status: 'failure' }),
    ]
    expect(planEmailSend(BASE, rows)).toMatchObject({
      send: true,
      idempotency_key: `${BASE}-retry-2`,
      attempt: 3,
    })
  })

  it('stops after MAX_EMAIL_ATTEMPTS instead of looping unboundedly', () => {
    const rows = attemptKeys(BASE).map((key, i) =>
      row({ id: `noti_${i}`, idempotency_key: key, status: 'failure' })
    )
    expect(planEmailSend(BASE, rows)).toMatchObject({
      send: false,
      reason: 'retry_budget_exhausted',
    })
  })

  it('tolerates null rows and rows without a key', () => {
    expect(
      planEmailSend(BASE, [null, undefined, { id: 'x', status: 'success' }])
    ).toMatchObject({ send: true, idempotency_key: BASE })
  })
})

describe('sendEmailNotification', () => {
  const input = {
    to: 'klant@example.nl',
    channel: 'email',
    template: 'order-placed',
    idempotency_key: BASE,
    data: {},
  } as any

  it('sends under the base key on a first attempt', async () => {
    const { container, createNotifications } = makeContainer([])

    const result = await sendEmailNotification(container, input)

    expect(result).toMatchObject({ sent: true, attempt: 1, idempotency_key: BASE })
    expect(createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: BASE })
    )
  })

  it('does not double-send after a success', async () => {
    const { container, createNotifications } = makeContainer([row({ status: 'success' })])

    const result = await sendEmailNotification(container, input)

    expect(result).toMatchObject({ sent: false, reason: 'already_sent' })
    expect(createNotifications).not.toHaveBeenCalled()
  })

  it('retries a failure under a fresh key, never the exhausted one', async () => {
    const { container, createNotifications } = makeContainer([row({ status: 'failure' })])

    const result = await sendEmailNotification(container, input)

    expect(result).toMatchObject({ sent: true, attempt: 2 })
    expect(createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: `${BASE}-retry-1`,
        original_notification_id: 'noti_1',
      })
    )
    // Medusa's own FAILURE-retry branch is what generates a phantom id and
    // throws NOT_FOUND. Handing it an existing key is exactly what we avoid.
    expect(createNotifications).not.toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: BASE })
    )
  })

  it('gives up loudly once the retry budget is spent', async () => {
    const rows = attemptKeys(BASE).map((key, i) =>
      row({ id: `noti_${i}`, idempotency_key: key, status: 'failure' })
    )
    const { container, createNotifications, logger } = makeContainer(rows)

    const result = await sendEmailNotification(container, input)

    expect(result).toMatchObject({ sent: false, reason: 'retry_budget_exhausted' })
    expect(createNotifications).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(Sentry.captureMessage).toHaveBeenCalled()
  })

  it('propagates a send failure so the caller can report it to Sentry', async () => {
    const { container, createNotifications } = makeContainer([])
    createNotifications.mockRejectedValueOnce(new Error('Resend: not_authorized'))

    await expect(sendEmailNotification(container, input)).rejects.toThrow(
      'Resend: not_authorized'
    )
  })

  it('skips the dedup lookup entirely when there is no idempotency key', async () => {
    const { container, listNotifications, createNotifications } = makeContainer([])

    const result = await sendEmailNotification(container, {
      ...input,
      idempotency_key: undefined,
    })

    expect(result).toMatchObject({ sent: true, idempotency_key: null })
    expect(listNotifications).not.toHaveBeenCalled()
    expect(createNotifications).toHaveBeenCalledTimes(1)
  })
})
