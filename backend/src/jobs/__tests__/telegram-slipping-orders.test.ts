import { runSlippingOrders } from '../telegram-slipping-orders'

const NOW = new Date('2026-07-15T16:00:00Z')
const OLD = '2026-07-13T10:00:00Z'   // > 24h ago
const FRESH = '2026-07-15T10:00:00Z' // < 24h ago

const paidPayment = {
  provider_id: 'pp_via_broker_via_broker',
  amount: 89.9,
  captures: [{ amount: 89.9 }],
  refunds: [],
  canceled_at: null,
}

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  display_id: 28412,
  status: 'pending',
  created_at: OLD,
  email: 'jan@x.nl',
  metadata: {},
  shipping_address: { first_name: 'Jan', last_name: 'J' },
  items: [{ id: 'item_1', quantity: 2 }],
  fulfillments: [],
  payment_collections: [{ payments: [paidPayment] }],
  ...over,
})

function makeContainer(rows: unknown[], events: Record<string, { sent_at?: string; snoozed_until?: string }> = {}) {
  const store = new Map(Object.entries(events).map(([k, v]) => [k, { id: `evt_${k}`, key: k, kind: 'reminder', sent_at: v.sent_at ?? null, snoozed_until: v.snoozed_until ?? null, payload: {} }]))
  const svc = {
    isConfigured: jest.fn(() => true),
    sendToAll: jest.fn().mockResolvedValue(undefined),
    findEvent: jest.fn(async (key: string) => store.get(key) ?? null),
    touchEvent: jest.fn(async (key: string, kind: string, data: Record<string, unknown>) => {
      store.set(key, { id: `evt_${key}`, key, kind, sent_at: (data.sent_at as never) ?? null, snoozed_until: null, payload: {} })
    }),
  }
  return {
    svc,
    resolve: jest.fn((key: string) => {
      if (key === 'telegram_ops') return svc
      if (key === 'query') return { graph: jest.fn().mockResolvedValue({ data: rows }) }
      if (key === 'logger') return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      return undefined
    }),
  }
}

describe('runSlippingOrders', () => {
  it('N9: paid order without label older than 24h, with label + snooze buttons', async () => {
    const c = makeContainer([orderRow()])
    await runSlippingOrders(c as never, NOW)
    expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
    const [text, extra] = c.svc.sendToAll.mock.calls[0]
    expect(text).toContain('Slipping')
    expect(text).toContain('#28412')
    const kb = JSON.stringify(extra)
    expect(kb).toContain('lbl:ord_1')
    expect(kb).toContain('snz:tg-slip-ord_1:1')
    expect(c.svc.touchEvent).toHaveBeenCalledWith('tg-slip-ord_1', 'reminder', expect.objectContaining({ sent_at: expect.any(Date) }))
  })

  it('N10: packed but unshipped older than 24h, ship + snooze buttons', async () => {
    const c = makeContainer([orderRow({ fulfillments: [{ id: 'ful_1', packed_at: OLD, shipped_at: null, canceled_at: null }] })])
    await runSlippingOrders(c as never, NOW)
    const [text, extra] = c.svc.sendToAll.mock.calls[0]
    expect(text).toContain('Packed but not shipped')
    const kb = JSON.stringify(extra)
    expect(kb).toContain('shp:ord_1:28412')
    expect(kb).toContain('snz:tg-unship-ord_1:1')
  })

  it('N11: a paid order with no Medusa capture row is reminded about, not skipped', async () => {
    // The live broker-callback-failure shape: the payment row carries the
    // authorized amount and no capture rows at all.
    const c = makeContainer([
      orderRow({
        payment_collections: [
          {
            payments: [
              {
                provider_id: 'pp_via_broker_via_broker',
                amount: { value: '89.9', precision: 20 },
                raw_amount: { value: '89.9', precision: 20 },
                captures: [],
                refunds: [],
                canceled_at: null,
              },
            ],
          },
        ],
      }),
    ])

    await runSlippingOrders(c as never, NOW)

    expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
    const [text, extra] = c.svc.sendToAll.mock.calls[0]
    expect(text).toContain('Needs attention')
    expect(text).toContain('#28412')
    expect(text).toContain('no capture row')
    const kb = JSON.stringify(extra)
    expect(kb).toContain('snz:tg-attn-ord_1:1')
    expect(c.svc.touchEvent).toHaveBeenCalledWith(
      'tg-attn-ord_1',
      'reminder',
      expect.objectContaining({ sent_at: expect.any(Date) })
    )
  })

  it('N11: a native "Fulfill items" fulfillment is reminded about', async () => {
    const c = makeContainer([
      orderRow({ fulfillments: [{ id: 'ful_1', packed_at: null, shipped_at: null, canceled_at: null }] }),
    ])
    await runSlippingOrders(c as never, NOW)
    expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
    expect(c.svc.sendToAll.mock.calls[0][0]).toContain('manual fulfillment')
  })

  it('N11: an attention order younger than 1h is left to the reconcile job', async () => {
    const c = makeContainer([
      orderRow({
        created_at: '2026-07-15T15:30:00Z',
        payment_collections: [
          {
            payments: [
              { provider_id: 'pp_via_broker_via_broker', amount: 89.9, captures: [], refunds: [], canceled_at: null },
            ],
          },
        ],
      }),
    ])
    await runSlippingOrders(c as never, NOW)
    expect(c.svc.sendToAll).not.toHaveBeenCalled()
  })

  it('fresh orders are not slipping', async () => {
    const c = makeContainer([orderRow({ created_at: FRESH })])
    await runSlippingOrders(c as never, NOW)
    expect(c.svc.sendToAll).not.toHaveBeenCalled()
  })

  it('sent < 24h ago stays silent; sent > 24h ago repeats', async () => {
    const recent = makeContainer([orderRow()], { 'tg-slip-ord_1': { sent_at: '2026-07-15T06:00:00Z' } })
    await runSlippingOrders(recent as never, NOW)
    expect(recent.svc.sendToAll).not.toHaveBeenCalled()

    const stale = makeContainer([orderRow()], { 'tg-slip-ord_1': { sent_at: '2026-07-14T06:00:00Z' } })
    await runSlippingOrders(stale as never, NOW)
    expect(stale.svc.sendToAll).toHaveBeenCalledTimes(1)
  })

  it('snoozed reminders stay silent until snoozed_until passes', async () => {
    const snoozed = makeContainer([orderRow()], { 'tg-slip-ord_1': { sent_at: '2026-07-13T06:00:00Z', snoozed_until: '2026-07-16T06:00:00Z' } })
    await runSlippingOrders(snoozed as never, NOW)
    expect(snoozed.svc.sendToAll).not.toHaveBeenCalled()

    const expired = makeContainer([orderRow()], { 'tg-slip-ord_1': { sent_at: '2026-07-13T06:00:00Z', snoozed_until: '2026-07-15T06:00:00Z' } })
    await runSlippingOrders(expired as never, NOW)
    expect(expired.svc.sendToAll).toHaveBeenCalledTimes(1)
  })
})
