jest.mock('../../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    ORDER_SHIPPED: 'order-shipped',
  },
}))

jest.mock('@medusajs/framework/utils', () => ({
  ContainerRegistrationKeys: {
    QUERY: 'query',
  },
  Modules: {
    NOTIFICATION: 'notificationModuleService',
  },
}))

import { sendOrderShippedNotification } from '../send-order-shipped'

const FULFILLMENT_ID = 'ful_abc123'
const ORDER_ID = 'order_xyz'

const mockFulfillment = {
  id: FULFILLMENT_ID,
  shipped_at: '2026-06-06T10:00:00Z',
  labels: [
    {
      tracking_number: 'JVGL01234567890',
      tracking_url: 'https://track.dhl.com/?trackingNumber=JVGL01234567890',
      label_url: 'https://r2.example.com/label.pdf',
    },
  ],
  items: [{ id: 'fi_1', line_item_id: 'item_1', quantity: 2 }],
}

const mockOrder = {
  id: ORDER_ID,
  display_id: 'INV-001',
  email: 'buyer@example.com',
  currency_code: 'EUR',
  shipping_address: {
    first_name: 'Jan',
    last_name: 'de Vries',
    address_1: 'Kerkstraat 1',
    city: 'Amsterdam',
    postal_code: '1012AA',
    country_code: 'NL',
  },
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

// The helper does a two-step lookup: `order_fulfillment` link entity first
// (filtering orders on `fulfillments.id` generates broken SQL on Medusa 2.12),
// then the order by its own id. The mock answers per entity so each call
// returns its own realistic shape, like tg-shipment-created.test.ts does.
function makeContainer(
  overrides: {
    notificationService?: Record<string, any>
    logger?: Record<string, any>
    links?: unknown[]
    orders?: unknown[]
  } = {}
) {
  const notificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
    ...overrides.notificationService,
  }
  const links = overrides.links ?? [{ order_id: ORDER_ID }]
  const orders = overrides.orders ?? [mockOrder]
  const query = {
    graph: jest.fn().mockImplementation(({ entity }: { entity: string }) => {
      if (entity === 'order_fulfillment') return Promise.resolve({ data: links })
      if (entity === 'order') return Promise.resolve({ data: orders })
      return Promise.resolve({ data: [] })
    }),
  }
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ...overrides.logger,
  }

  return {
    resolve: jest.fn((key: string) => {
      if (key === 'notificationModuleService') return notificationService
      if (key === 'query') return query
      if (key === 'logger') return logger
      throw new Error(`Unknown key: ${key}`)
    }),
    _notificationService: notificationService,
    _query: query,
    _logger: logger,
  }
}

describe('sendOrderShippedNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.SUPPORT_EMAIL
    delete process.env.CONTACT_EMAIL
  })

  it('calls createNotifications with ORDER_SHIPPED template and correct data', async () => {
    const container = makeContainer()
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

    expect(result).toEqual({ sent: true })
    expect(container._notificationService.createNotifications).toHaveBeenCalledTimes(1)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.template).toBe('order-shipped')
    expect(call.to).toBe('buyer@example.com')
    expect(call.channel).toBe('email')
  })

  it('uses the idempotency_key order-shipped-<fulfillmentId>', async () => {
    const container = makeContainer()
    await sendOrderShippedNotification(container, FULFILLMENT_ID)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.idempotency_key).toBe(`order-shipped-${FULFILLMENT_ID}`)
  })

  it('passes the correct labels to the notification data', async () => {
    const container = makeContainer()
    await sendOrderShippedNotification(container, FULFILLMENT_ID)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.data.labels).toEqual([
      {
        tracking_number: 'JVGL01234567890',
        tracking_url: 'https://track.dhl.com/?trackingNumber=JVGL01234567890',
        label_url: 'https://r2.example.com/label.pdf',
      },
    ])
  })

  it('assembles shipmentItems from the fulfillment items', async () => {
    const container = makeContainer()
    await sendOrderShippedNotification(container, FULFILLMENT_ID)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.data.items).toEqual([
      { id: 'item_1', title: 'BPC-157 | 5mg', quantity: 2 },
    ])
  })

  it('returns { sent: false } and skips send when noNotification is true', async () => {
    const container = makeContainer()
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID, {
      noNotification: true,
    })

    expect(result).toEqual({ sent: false })
    expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
    expect(container._logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no_notification flag set')
    )
  })

  it('returns { sent: false } when no order is found for the fulfillment', async () => {
    const container = makeContainer({ orders: [] })
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

    expect(result).toEqual({ sent: false })
    expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
    expect(container._logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no order found')
    )
  })

  it('returns { sent: false } when the order has no email', async () => {
    const orderWithoutEmail = { ...mockOrder, email: undefined }
    const container = makeContainer({ orders: [orderWithoutEmail] })
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

    expect(result).toEqual({ sent: false })
    expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
    expect(container._logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('has no email')
    )
  })

  it('returns { sent: false } when the order has no shipping_address', async () => {
    const orderWithoutAddress = { ...mockOrder, shipping_address: null }
    const container = makeContainer({ orders: [orderWithoutAddress] })
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

    expect(result).toEqual({ sent: false })
    expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
    expect(container._logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('has no shipping_address')
    )
  })

  it('returns { sent: false } when the fulfillment is not found on the order', async () => {
    const orderDifferentFulfillment = {
      ...mockOrder,
      fulfillments: [{ ...mockFulfillment, id: 'ful_other' }],
    }
    const container = makeContainer({ orders: [orderDifferentFulfillment] })
    const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

    expect(result).toEqual({ sent: false })
    expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
    expect(container._logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found on order')
    )
  })

  it('includes replyTo from SUPPORT_EMAIL env when set', async () => {
    process.env.SUPPORT_EMAIL = 'support@inovix-peptides.nl'
    const container = makeContainer()
    await sendOrderShippedNotification(container, FULFILLMENT_ID)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.data.emailOptions.replyTo).toBe('support@inovix-peptides.nl')
    delete process.env.SUPPORT_EMAIL
  })

  it('sets the Dutch subject line with display_id', async () => {
    const container = makeContainer()
    await sendOrderShippedNotification(container, FULFILLMENT_ID)

    const call = container._notificationService.createNotifications.mock.calls[0][0]
    expect(call.data.emailOptions.subject).toBe(
      'Uw bestelling is onderweg | Inovix INV-001'
    )
  })

  // The shipment.created subscriber (src/subscribers/order-shipped.ts) passes
  // no orderId, so every non-DHL-flow shipped email depends on this branch.
  describe('order id resolution', () => {
    it('resolves the order via the order_fulfillment link, never via a cross-module fulfillments filter', async () => {
      const container = makeContainer()
      const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

      expect(result).toEqual({ sent: true })
      expect(container._query.graph).toHaveBeenCalledTimes(2)
      // First call: link entity keyed by fulfillment_id. Filtering orders on
      // fulfillments.id generated broken SQL on Medusa 2.12 ("missing
      // FROM-clause entry for table fulfillments", Sentry INOVIX-BACKEND-B)
      // and silently killed every shipped email.
      expect(container._query.graph).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          entity: 'order_fulfillment',
          filters: { fulfillment_id: FULFILLMENT_ID },
        })
      )
      // Second call: order by its own id only.
      expect(container._query.graph).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ entity: 'order', filters: { id: ORDER_ID } })
      )
      for (const call of container._query.graph.mock.calls) {
        expect(JSON.stringify(call[0].filters)).not.toContain('fulfillments')
      }
    })

    it('skips the link lookup when the caller passes orderId', async () => {
      const container = makeContainer()
      const result = await sendOrderShippedNotification(container, FULFILLMENT_ID, {
        orderId: ORDER_ID,
      })

      expect(result).toEqual({ sent: true })
      expect(container._query.graph).toHaveBeenCalledTimes(1)
      expect(container._query.graph).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'order', filters: { id: ORDER_ID } })
      )
    })

    it('returns { sent: false } when the fulfillment has no order link', async () => {
      const container = makeContainer({ links: [] })
      const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

      expect(result).toEqual({ sent: false })
      expect(container._query.graph).toHaveBeenCalledTimes(1)
      expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
      expect(container._logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no order link found')
      )
    })

    // Live query.graph hands back null relation elements and rows missing the
    // requested field; neither may throw on the way to the customer email.
    it.each([
      ['a null relation element', [null]],
      ['a row without order_id', [{}]],
      ['a row with a null order_id', [{ order_id: null }]],
    ])('returns { sent: false } when the link lookup yields %s', async (_label, links) => {
      const container = makeContainer({ links })
      const result = await sendOrderShippedNotification(container, FULFILLMENT_ID)

      expect(result).toEqual({ sent: false })
      expect(container._notificationService.createNotifications).not.toHaveBeenCalled()
      expect(container._logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no order link found')
      )
    })
  })
})
