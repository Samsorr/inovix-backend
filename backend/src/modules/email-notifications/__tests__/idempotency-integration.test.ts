/**
 * End-to-end proof of the CRITICAL fix, wiring the REAL ResendNotificationService
 * to a faithful replica of Medusa 2.12.1's notification module.
 *
 * The replica copies `createNotifications_` verbatim in behaviour, including the
 * upstream bug: a FAILURE row is re-processed under a freshly generated id that
 * was never inserted, so the trailing `update()` throws NOT_FOUND and the row
 * stays `failure` forever while the email keeps going out.
 *
 * What this file has to demonstrate:
 *   1. A Resend `{ data: null, error }` response is NOT recorded as sent.
 *   2. It does NOT consume the idempotency key: the next trigger really re-sends.
 *   3. A genuine success still cannot double-send.
 *   4. The retry ladder is finite, so nothing loops unboundedly.
 */

jest.mock('../../../lib/instrument', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}))

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn() },
  })),
}), { virtual: true })

jest.mock('@medusajs/framework/utils', () => ({
  Modules: { NOTIFICATION: 'notification' },
  AbstractNotificationProviderService: class {},
  MedusaError: class MedusaError extends Error {
    static Types = {
      INVALID_DATA: 'invalid_data',
      UNEXPECTED_STATE: 'unexpected_state',
      NOT_FOUND: 'not_found',
    }
    type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  },
}))

jest.mock('../templates', () => ({
  generateEmailTemplate: jest.fn().mockReturnValue('<div>Email</div>'),
}))

import { ResendNotificationService } from '../services/resend'
import { attemptKeys, sendEmailNotification } from '../send-notification'

const KEY = 'order-confirmed-order_1'
/** More re-deliveries than the ladder has rungs, on purpose. */
const MAX_TRIGGERS = 10
const RESEND_OK = { data: { id: 'email_abc' }, error: null }
const RESEND_403 = {
  data: null,
  error: { name: 'not_authorized', message: 'This API key is restricted' },
}

type Row = {
  id: string
  idempotency_key: string | null
  status: string
  external_id: string | null
  created_at: string
}

/** Replica of @medusajs/notification 2.12.1 NotificationModuleService. */
function makeMedusaNotificationModule(provider: ResendNotificationService) {
  const rows: Row[] = []
  let seq = 0
  const newId = () => `noti_${++seq}`

  async function listNotifications(filters: any = {}) {
    let out = rows
    if (filters.idempotency_key) {
      const keys = Array.isArray(filters.idempotency_key)
        ? filters.idempotency_key
        : [filters.idempotency_key]
      out = out.filter((r) => keys.includes(r.idempotency_key))
    }
    if (filters.id) out = out.filter((r) => r.id === filters.id)
    // Serialized copies, like the real module.
    return out.map((r) => ({ ...r }))
  }

  async function createNotifications(entry: any) {
    const existing = entry.idempotency_key
      ? rows.find((r) => r.idempotency_key === entry.idempotency_key)
      : undefined

    // notificationsToProcess: skip anything already present unless it FAILED.
    if (existing && existing.status !== 'failure') return undefined

    // A fresh id is generated even for the retry branch (upstream line 64)...
    const id = newId()
    // ...but `toCreate` filters the insert out when the key already exists
    // (upstream line 71), so the retry runs against a phantom id.
    if (!existing) {
      rows.push({
        id,
        idempotency_key: entry.idempotency_key ?? null,
        status: 'pending',
        external_id: null,
        created_at: new Date().toISOString(),
      })
    }

    let status = 'pending'
    let externalId: string | null = null
    let sendError: unknown = null
    try {
      const res = await provider.send({ ...entry, id })
      externalId = (res as any)?.id ?? null
      status = 'success'
    } catch (err) {
      status = 'failure'
      sendError = err
    }

    // finally { update(...) } | throws NOT_FOUND on a phantom id.
    const target = rows.find((r) => r.id === id)
    if (!target) {
      throw new Error(`Notification with id: ${id} was not found`)
    }
    target.status = status
    target.external_id = externalId

    if (sendError) throw sendError
    return { ...target }
  }

  return { rows, listNotifications, createNotifications }
}

function makeSetup() {
  const provider = new ResendNotificationService(
    { logger: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any },
    { api_key: 'test', from: 'Inovix <info@inovix.nl>' }
  )
  const { Resend } = require('resend')
  const resendSend = Resend.mock.results[0].value.emails.send as jest.Mock

  const notificationModule = makeMedusaNotificationModule(provider)
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container: any = {
    resolve: (k: string) => {
      if (k === 'notification') return notificationModule
      if (k === 'logger') return logger
      throw new Error(`unexpected resolve: ${k}`)
    },
  }
  return { container, notificationModule, resendSend, logger }
}

const NOTIFICATION = {
  to: 'klant@example.nl',
  channel: 'email',
  template: 'order-placed',
  idempotency_key: KEY,
  data: { emailOptions: { subject: 'Bestelling bevestigd' } },
} as any

describe('Resend failure + idempotency, end to end', () => {
  it('does NOT record a 403 as sent', async () => {
    const { container, notificationModule, resendSend } = makeSetup()
    resendSend.mockResolvedValueOnce(RESEND_403)

    await expect(sendEmailNotification(container, NOTIFICATION)).rejects.toThrow(
      /not_authorized/
    )

    expect(notificationModule.rows).toHaveLength(1)
    expect(notificationModule.rows[0].status).toBe('failure')
    expect(notificationModule.rows[0].external_id).toBeNull()
  })

  it('does NOT consume the idempotency key: the next trigger really re-sends', async () => {
    const { container, notificationModule, resendSend } = makeSetup()

    // order.placed fires, Resend 403s.
    resendSend.mockResolvedValueOnce(RESEND_403)
    await expect(sendEmailNotification(container, NOTIFICATION)).rejects.toThrow()

    // payment.captured fires next with the SAME base key. The customer must
    // still get their confirmation.
    resendSend.mockResolvedValueOnce(RESEND_OK)
    const second = await sendEmailNotification(container, NOTIFICATION)

    expect(second).toMatchObject({ sent: true, attempt: 2 })
    expect(resendSend).toHaveBeenCalledTimes(2)
    expect(notificationModule.rows).toHaveLength(2)
    expect(notificationModule.rows[1]).toMatchObject({
      idempotency_key: `${KEY}-retry-1`,
      status: 'success',
      // Populating external_id is what makes a send auditable at all.
      external_id: 'email_abc',
    })
  })

  it('a genuine success still cannot double-send', async () => {
    const { container, notificationModule, resendSend } = makeSetup()

    resendSend.mockResolvedValueOnce(RESEND_OK)
    await sendEmailNotification(container, NOTIFICATION)

    const second = await sendEmailNotification(container, NOTIFICATION)
    const third = await sendEmailNotification(container, NOTIFICATION)

    expect(second).toMatchObject({ sent: false, reason: 'already_sent' })
    expect(third).toMatchObject({ sent: false, reason: 'already_sent' })
    expect(resendSend).toHaveBeenCalledTimes(1)
    expect(notificationModule.rows).toHaveLength(1)
  })

  it('stops re-sending once the finite retry ladder is spent', async () => {
    const { container, resendSend } = makeSetup()
    resendSend.mockResolvedValue(RESEND_403)

    for (let i = 0; i < MAX_TRIGGERS; i++) {
      await sendEmailNotification(container, NOTIFICATION).catch(() => undefined)
    }

    // One send per rung of the ladder and not one more, however often the
    // event is re-delivered.
    expect(resendSend).toHaveBeenCalledTimes(attemptKeys(KEY).length)
  })

  it('never hands Medusa an existing key, so the NOT_FOUND phantom-id bug cannot fire', async () => {
    const { container, notificationModule, resendSend } = makeSetup()

    resendSend.mockResolvedValueOnce(RESEND_403)
    await expect(sendEmailNotification(container, NOTIFICATION)).rejects.toThrow(
      /not_authorized/
    )

    resendSend.mockResolvedValueOnce(RESEND_OK)
    await expect(sendEmailNotification(container, NOTIFICATION)).resolves.toMatchObject({
      sent: true,
    })

    // Control: calling the module directly with the already-failed key is the
    // upstream path. It sends the email AND throws NOT_FOUND, leaving the row
    // at `failure` so the next trigger sends yet another copy. That is exactly
    // what sendEmailNotification routes around.
    const before = resendSend.mock.calls.length
    resendSend.mockResolvedValueOnce(RESEND_OK)
    await expect(
      notificationModule.createNotifications({ ...NOTIFICATION })
    ).rejects.toThrow(/was not found/)
    expect(resendSend).toHaveBeenCalledTimes(before + 1)
    expect(notificationModule.rows[0].status).toBe('failure')
  })
})
