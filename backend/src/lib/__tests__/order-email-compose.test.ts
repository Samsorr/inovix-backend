jest.mock('../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    ORDER_PLACED: 'order-placed',
    ORDER_SHIPPED: 'order-shipped',
  },
}))

jest.mock('@medusajs/framework/utils', () => ({
  ContainerRegistrationKeys: {
    QUERY: 'query',
  },
  Modules: {
    NOTIFICATION: 'notificationModuleService',
    ORDER: 'orderModuleService',
  },
}))

import {
  applyOverrides,
  composeOrderPlacedEmail,
  composeOrderShipped,
  composeOrderShippedEmail,
} from '../order-email-compose'

const FULFILLMENT_ID = 'ful_abc123'
const ORDER_ID = 'order_xyz'

const mockFulfillment = {
  id: FULFILLMENT_ID,
  shipped_at: '2026-06-06T10:00:00Z',
  labels: [
    {
      tracking_number: 'JVGL01234567890',
      tracking_url:
        'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1012AA?lang=nl_NL',
      label_url: 'https://r2.example.com/label.pdf',
    },
  ],
  items: [{ id: 'fi_1', line_item_id: 'item_1', quantity: 2 }],
}

const mockShippingAddress = {
  first_name: 'Jan',
  last_name: 'de Vries',
  address_1: 'Kerkstraat 1',
  city: 'Amsterdam',
  postal_code: '1012AA',
  country_code: 'NL',
}

const mockGraphOrder = {
  id: ORDER_ID,
  display_id: 'INV-001',
  email: 'buyer@example.com',
  currency_code: 'EUR',
  shipping_address: mockShippingAddress,
  items: [
    {
      id: 'item_1',
      product_title: 'BPC-157',
      variant_title: '5mg',
      title: 'BPC-157 5mg',
    },
  ],
  fulfillments: [mockFulfillment],
}

// The order the ORDER module hands back for the confirmation mail: retrieved
// with relations, so it carries items, summary and shipping_address.
const mockRetrievedOrder = {
  id: ORDER_ID,
  display_id: 'INV-001',
  email: 'buyer@example.com',
  currency_code: 'EUR',
  metadata: null,
  shipping_address: mockShippingAddress,
  items: [
    {
      id: 'item_1',
      product_title: 'BPC-157',
      variant_title: '5mg',
      quantity: 2,
      unit_price: 49.99,
    },
  ],
  summary: { raw_current_order_total: { value: 99.98 } },
}

/**
 * Same container-mocking style as `src/subscribers/__tests__/`: one
 * `query.graph` that answers per entity (a mock returning a single object for
 * every call makes a two-step lookup pass without ever running), plus the
 * module services behind `resolve`.
 */
function makeContainer(
  overrides: {
    links?: unknown[]
    orders?: unknown[]
    carts?: unknown[]
    retrievedOrder?: unknown
  } = {}
) {
  const links = overrides.links ?? [{ order_id: ORDER_ID }]
  const orders = overrides.orders ?? [mockGraphOrder]
  const carts = overrides.carts ?? []
  const retrievedOrder =
    'retrievedOrder' in overrides ? overrides.retrievedOrder : mockRetrievedOrder

  const query = {
    graph: jest.fn().mockImplementation(({ entity }: { entity: string }) => {
      if (entity === 'order_fulfillment') return Promise.resolve({ data: links })
      if (entity === 'order') return Promise.resolve({ data: orders })
      if (entity === 'order_cart') return Promise.resolve({ data: carts })
      return Promise.resolve({ data: [] })
    }),
  }

  const orderModuleService = {
    retrieveOrder: jest.fn().mockResolvedValue(retrievedOrder),
  }

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  return {
    resolve: jest.fn((key: string) => {
      if (key === 'query') return query
      if (key === 'orderModuleService') return orderModuleService
      if (key === 'logger') return logger
      throw new Error(`Unknown key: ${key}`)
    }),
    _query: query,
    _orderModuleService: orderModuleService,
  }
}

describe('composeOrderShippedEmail', () => {
  beforeEach(() => {
    delete process.env.SUPPORT_EMAIL
    delete process.env.CONTACT_EMAIL
  })

  it('returns the exact payload shape the sender used before', async () => {
    const container = makeContainer()
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID)

    expect(composed).not.toBeNull()
    expect(composed!.to).toBe('buyer@example.com')
    expect(composed!.template).toBe('order-shipped')
    expect(composed!.locale).toBe('nl')
    expect(composed!.resourceId).toBe(ORDER_ID)

    // Freeze the payload shape: the admin composer and the automatic sender
    // must keep passing the same keys.
    expect(Object.keys(composed!.data).sort()).toEqual([
      'emailOptions',
      'items',
      'labels',
      'locale',
      'order',
      'preview',
      'shippedAt',
      'shippingAddress',
    ])

    expect(composed!.data.emailOptions.subject).toBe(
      'Uw bestelling is onderweg | Inovix INV-001'
    )
    expect(composed!.data.order).toEqual({
      id: ORDER_ID,
      display_id: 'INV-001',
      email: 'buyer@example.com',
      currency_code: 'EUR',
    })
    expect(composed!.data.shippingAddress).toEqual(mockShippingAddress)
    expect(composed!.data.labels).toEqual([
      {
        tracking_number: 'JVGL01234567890',
        tracking_url:
          'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1012AA?lang=nl_NL',
        label_url: 'https://r2.example.com/label.pdf',
      },
    ])
    expect(composed!.data.items).toEqual([
      { id: 'item_1', title: 'BPC-157 | 5mg', quantity: 2 },
    ])
    expect(composed!.data.shippedAt).toBe('2026-06-06T10:00:00Z')
    expect(composed!.data.locale).toBe('nl')
    expect(composed!.data.preview).toBe('Uw bestelling is onderweg')
  })

  it('puts replyTo in emailOptions when SUPPORT_EMAIL is set', async () => {
    process.env.SUPPORT_EMAIL = 'info@inovix.nl'
    const container = makeContainer()
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID)

    expect(composed!.data.emailOptions.replyTo).toBe('info@inovix.nl')
    delete process.env.SUPPORT_EMAIL
  })

  // Behaviour that must not be lost in the extraction: the DHL portal opens in
  // the language of the email.
  it('rewrites the DHL portal language to match the locale', async () => {
    const container = makeContainer({
      retrievedOrder: { id: ORDER_ID, metadata: { locale: 'de' } },
    })
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID)

    expect(composed!.locale).toBe('de')
    expect(composed!.data.locale).toBe('de')
    expect(composed!.data.labels[0].tracking_url).toBe(
      'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1012AA?lang=de_DE'
    )
    expect(composed!.data.emailOptions.subject).toBe(
      'Ihre Bestellung ist unterwegs | Inovix INV-001'
    )
  })

  it('leaves a non-DHL-portal tracking URL alone', async () => {
    const container = makeContainer({
      orders: [
        {
          ...mockGraphOrder,
          fulfillments: [
            {
              ...mockFulfillment,
              labels: [
                {
                  tracking_number: 'JVGL01234567890',
                  tracking_url:
                    'https://track.dhl.com/?trackingNumber=JVGL01234567890',
                  label_url: null,
                },
              ],
            },
          ],
        },
      ],
    })
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID)

    expect(composed!.data.labels[0].tracking_url).toBe(
      'https://track.dhl.com/?trackingNumber=JVGL01234567890'
    )
  })

  it('bases the idempotency key on the fulfillment id', async () => {
    const container = makeContainer()
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID)

    expect(composed!.idempotencyKeyBase).toBe(`order-shipped-${FULFILLMENT_ID}`)
  })

  it('returns null when the order has no shipping address', async () => {
    const container = makeContainer({
      orders: [{ ...mockGraphOrder, shipping_address: null }],
    })

    expect(await composeOrderShippedEmail(container, FULFILLMENT_ID)).toBeNull()
  })

  it('returns null when no label carries tracking', async () => {
    const container = makeContainer({
      orders: [
        {
          ...mockGraphOrder,
          fulfillments: [{ ...mockFulfillment, labels: [] }],
        },
      ],
    })

    expect(await composeOrderShippedEmail(container, FULFILLMENT_ID)).toBeNull()
  })

  // The automatic sender opts out of the tracking requirement: a manually
  // fulfilled order has no DHL label and still mails the customer today.
  it('still composes an untracked shipment when requireTracking is false', async () => {
    const container = makeContainer({
      orders: [
        {
          ...mockGraphOrder,
          fulfillments: [{ ...mockFulfillment, labels: [] }],
        },
      ],
    })
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID, {
      requireTracking: false,
    })

    expect(composed).not.toBeNull()
    expect(composed!.data.labels).toEqual([])
  })

  it('reports why it could not compose, for the sender log line', async () => {
    const container = makeContainer({ links: [] })
    const result = await composeOrderShipped(container, FULFILLMENT_ID)

    expect(result.email).toBeUndefined()
    expect(result.reason).toBe('no_order_link')
  })

  it('skips the link lookup when the caller knows the order id', async () => {
    const container = makeContainer()
    const composed = await composeOrderShippedEmail(container, FULFILLMENT_ID, {
      orderId: ORDER_ID,
    })

    expect(composed).not.toBeNull()
    for (const call of container._query.graph.mock.calls) {
      expect(call[0].entity).not.toBe('order_fulfillment')
    }
  })
})

describe('composeOrderPlacedEmail', () => {
  beforeEach(() => {
    delete process.env.SUPPORT_EMAIL
    delete process.env.CONTACT_EMAIL
  })

  it('returns the exact payload shape the subscriber used before', async () => {
    const container = makeContainer()
    const composed = await composeOrderPlacedEmail(container, ORDER_ID)

    expect(composed).not.toBeNull()
    expect(composed!.to).toBe('buyer@example.com')
    expect(composed!.template).toBe('order-placed')
    expect(composed!.locale).toBe('nl')
    expect(composed!.resourceId).toBe(ORDER_ID)
    expect(composed!.idempotencyKeyBase).toBe(`order-confirmed-${ORDER_ID}`)

    expect(Object.keys(composed!.data).sort()).toEqual([
      'emailOptions',
      'locale',
      'order',
      'preview',
      'shippingAddress',
    ])

    expect(composed!.data.emailOptions.subject).toBe(
      'Bestelling bevestigd | Inovix INV-001'
    )
    // The plain-text alternative the subscriber built inline before.
    expect(composed!.data.emailOptions.text).toContain('INV-001')
    expect(composed!.data.emailOptions.text).toContain('BPC-157')
    expect(composed!.data.order).toBe(mockRetrievedOrder)
    expect(composed!.data.shippingAddress).toEqual(mockShippingAddress)
    expect(composed!.data.locale).toBe('nl')
    expect(composed!.data.preview).toBe(
      'Uw betaling is verwerkt | bestelling bevestigd'
    )
  })

  it('retrieves the order with the items, summary and address relations', async () => {
    const container = makeContainer()
    await composeOrderPlacedEmail(container, ORDER_ID)

    expect(container._orderModuleService.retrieveOrder).toHaveBeenCalledWith(
      ORDER_ID,
      { relations: ['items', 'summary', 'shipping_address'] }
    )
  })

  it('returns null when the order has no shipping address', async () => {
    const container = makeContainer({
      retrievedOrder: { ...mockRetrievedOrder, shipping_address: null },
    })

    expect(await composeOrderPlacedEmail(container, ORDER_ID)).toBeNull()
  })
})

describe('applyOverrides', () => {
  const base = {
    emailOptions: { replyTo: 'info@inovix.nl', subject: 'Standaard onderwerp' },
    order: { id: ORDER_ID },
  }

  it('moves subject to emailOptions and drops it from overrides', () => {
    const next = applyOverrides(base, {
      subject: 'Eigen onderwerp',
      body: 'Eigen tekst',
    })

    expect(next.emailOptions.subject).toBe('Eigen onderwerp')
    expect(next.emailOptions.replyTo).toBe('info@inovix.nl')
    expect(next.overrides).toEqual({ body: 'Eigen tekst' })
    expect(next.overrides.subject).toBeUndefined()
    expect(next.edited).toBe(true)
  })

  it('puts a non-empty remainder on data.overrides', () => {
    const next = applyOverrides(base, { body: 'Eigen tekst' })

    expect(next.overrides).toEqual({ body: 'Eigen tekst' })
    expect(next.emailOptions.subject).toBe('Standaard onderwerp')
    expect(next.edited).toBe(true)
  })

  it('adds no overrides key when the remainder is empty', () => {
    const next = applyOverrides(base, { subject: 'Alleen het onderwerp' })

    expect('overrides' in next).toBe(false)
    expect(next.emailOptions.subject).toBe('Alleen het onderwerp')
  })

  // The subject-only hole: `overrides` is empty after the subject moves to
  // emailOptions, so `data.edited` is the only thing that can keep the
  // "Bewerkt" badge honest. Stamped inside applyOverrides so the preview and
  // both send paths cannot disagree about it.
  it('still marks a subject-only edit as edited', () => {
    const next = applyOverrides(base, { subject: 'Alleen het onderwerp' })

    expect(next.edited).toBe(true)
    expect('overrides' in next).toBe(false)
  })

  it('adds no overrides key for an empty override set', () => {
    const next = applyOverrides(base, {})

    expect('overrides' in next).toBe(false)
    expect(next.emailOptions.subject).toBe('Standaard onderwerp')
  })

  it('does not mark an unedited send as edited', () => {
    const next = applyOverrides(base, {})

    expect('edited' in next).toBe(false)
  })

  it('does not mutate the composed payload', () => {
    const next = applyOverrides(base, {
      subject: 'Eigen onderwerp',
      body: 'Eigen tekst',
    })

    expect(base.emailOptions.subject).toBe('Standaard onderwerp')
    expect((base as Record<string, any>).overrides).toBeUndefined()
    expect(next).not.toBe(base)
  })
})
