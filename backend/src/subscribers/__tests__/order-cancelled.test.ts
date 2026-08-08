jest.mock('../../lib/instrument', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}))

jest.mock('../../lib/email-locale', () => ({
  resolveOrderEmailLocale: jest.fn().mockResolvedValue('nl'),
  normalizeEmailLocale: (l: string) => l,
}))

import orderCancelledHandler, {
  resolveOrderMoneyState,
} from '../order-cancelled'
import { ORDER_CANCELLED_I18N } from '../../modules/email-notifications/templates/email-i18n'

const ORDER_ID = 'order_abc'

const mockShippingAddress = {
  first_name: 'Jan',
  last_name: 'de Vries',
  address_1: 'Voorbeeldstraat 12',
  city: 'Amsterdam',
  postal_code: '1011 AB',
  country_code: 'NL',
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    display_id: 'ORD-001',
    email: 'buyer@example.com',
    currency_code: 'eur',
    canceled_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    items: [
      {
        id: 'item-1',
        product_title: 'BPC-157',
        variant_title: '10mg',
        quantity: 2,
        unit_price: 45,
      },
    ],
    shipping_address: mockShippingAddress,
    summary: { raw_current_order_total: { value: 90 } },
    ...overrides,
  }
}

function makeContainer(
  paymentCollections: unknown[],
  order: Record<string, unknown> = makeOrder()
) {
  const createNotifications = jest.fn().mockResolvedValue(undefined)
  const listNotifications = jest.fn().mockResolvedValue([])
  const retrieveOrder = jest.fn().mockResolvedValue(order)
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const query = {
    graph: jest
      .fn()
      .mockResolvedValue({ data: [{ id: ORDER_ID, payment_collections: paymentCollections }] }),
  }
  const container: any = {
    resolve: (key: string) => {
      if (key === 'order') return { retrieveOrder }
      if (key === 'query') return query
      if (key === 'logger') return logger
      // Modules.NOTIFICATION resolves to this under jest.
      return { createNotifications, listNotifications }
    },
  }
  return { container, createNotifications, logger, query }
}

async function run(container: any) {
  await orderCancelledHandler({
    event: { data: { id: ORDER_ID } },
    container,
  } as any)
}

describe('resolveOrderMoneyState', () => {
  it('reports not_charged when nothing was captured', () => {
    expect(resolveOrderMoneyState([{ captured_amount: 0 }], 90)).toEqual({
      state: 'not_charged',
      amount: 90,
    })
  })

  it('reports not_charged when there is no payment collection at all', () => {
    expect(resolveOrderMoneyState([], 90).state).toBe('not_charged')
    expect(resolveOrderMoneyState(null, 90).state).toBe('not_charged')
    expect(resolveOrderMoneyState(undefined, null).state).toBe('not_charged')
  })

  it('reports refund_pending on captured money that is still with us', () => {
    expect(
      resolveOrderMoneyState([{ captured_amount: 90, refunded_amount: 0 }], 90)
    ).toEqual({ state: 'refund_pending', amount: 90 })
  })

  it('reports the outstanding amount after a partial refund', () => {
    expect(
      resolveOrderMoneyState([{ captured_amount: 90, refunded_amount: 30 }], 90)
    ).toEqual({ state: 'refund_pending', amount: 60 })
  })

  it('reports refunded once everything captured is back', () => {
    expect(
      resolveOrderMoneyState([{ captured_amount: 90, refunded_amount: 90 }], 90)
    ).toEqual({ state: 'refunded', amount: 90 })
  })

  it('tolerates string amounts and null collection elements', () => {
    expect(
      resolveOrderMoneyState([null, { captured_amount: '90' }], '90')
    ).toEqual({ state: 'refund_pending', amount: 90 })
  })
})

describe('order.canceled email copy per money state', () => {
  const nl = ORDER_CANCELLED_I18N.nl

  it('never promises a refund when nothing was captured', async () => {
    const { container, createNotifications } = makeContainer([
      { status: 'awaiting', captured_amount: 0 },
    ])

    await run(container)

    const call = createNotifications.mock.calls[0][0]
    expect(call.data.refundState).toBe('not_charged')

    const text: string = call.data.emailOptions.text
    expect(text).toContain('geen bedrag afgeschreven')
    expect(text).toContain(nl.not_charged.whenHeading)
    // The exact promise that must not go out on an unpaid order.
    expect(text).not.toContain('wordt teruggestort')
    expect(text).not.toContain('5 tot 10 werkdagen')
  })

  it('promises the refund when money was actually captured', async () => {
    const { container, createNotifications } = makeContainer([
      { status: 'completed', captured_amount: 90 },
    ])

    await run(container)

    const call = createNotifications.mock.calls[0][0]
    expect(call.data.refundState).toBe('refund_pending')
    expect(call.data.refundAmount).toBe(90)

    const text: string = call.data.emailOptions.text
    expect(text).toContain('wordt teruggestort')
    expect(text).toContain('Terug te storten bedrag: 90.00 EUR')
  })

  it('says the money is already back when it has been refunded', async () => {
    const { container, createNotifications } = makeContainer([
      { status: 'completed', captured_amount: 90, refunded_amount: 90 },
    ])

    await run(container)

    const call = createNotifications.mock.calls[0][0]
    expect(call.data.refundState).toBe('refunded')

    const text: string = call.data.emailOptions.text
    expect(text).toContain('is al teruggestort')
    expect(text).toContain('Teruggestort bedrag')
    expect(text).not.toContain('U ontvangt een aparte bevestiging')
  })

  it('shows only the outstanding amount after a partial refund', async () => {
    const { container, createNotifications } = makeContainer([
      { status: 'completed', captured_amount: 90, refunded_amount: 30 },
    ])

    await run(container)

    const call = createNotifications.mock.calls[0][0]
    expect(call.data.refundAmount).toBe(60)
    expect(call.data.emailOptions.text).toContain('60.00 EUR')
  })

  it('sends with an idempotency key so a re-cancel cannot mail twice', async () => {
    const { container, createNotifications } = makeContainer([
      { status: 'completed', captured_amount: 90 },
    ])

    await run(container)

    expect(createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: `order-cancelled-${ORDER_ID}`,
        resource_id: ORDER_ID,
        resource_type: 'order',
        trigger_type: 'order.canceled',
      })
    )
  })

  it('has no em dashes in any locale of the cancellation copy', () => {
    for (const locale of ['nl', 'de', 'en'] as const) {
      const l = ORDER_CANCELLED_I18N[locale]
      for (const state of ['refund_pending', 'refunded', 'not_charged'] as const) {
        const s = l[state]
        const strings = [
          s.body('1'),
          s.amountLabel,
          s.whenHeading,
          s.whenBody1,
          s.whenBody2,
        ]
        for (const value of strings) expect(value).not.toContain('—')
      }
    }
  })
})
