jest.mock('../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    INVITE_USER: 'invite-user',
    ORDER_PLACED: 'order-placed',
  },
}))

jest.mock('@medusajs/framework/utils', () => ({
  Modules: {
    NOTIFICATION: 'notificationModuleService',
    ORDER: 'orderModuleService',
  },
  ContainerRegistrationKeys: {
    QUERY: 'query',
  },
}))

import orderPlacedHandler, { config } from '../order-placed'

describe('order-placed subscriber', () => {
  const mockShippingAddress = {
    id: 'addr_1',
    first_name: 'John',
    last_name: 'Doe',
    address_1: '123 Lab Street',
    city: 'Amsterdam',
    province: 'NH',
    postal_code: '1012AB',
    country_code: 'NL',
  }

  const mockOrder = {
    id: 'order_abc',
    email: 'buyer@example.com',
    display_id: 'ORD-001',
    currency_code: 'EUR',
    payment_status: 'captured',
    items: [
      { id: 'item-1', title: 'BPC-157', product_title: 'Peptide', quantity: 1, unit_price: 49.99 },
    ],
    shipping_address: mockShippingAddress,
    summary: { raw_current_order_total: { value: 49.99 } },
    created_at: new Date().toISOString(),
  }

  const mockNotificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
    // The confirmation goes through sendEmailNotification, which reads the
    // existing rows for this idempotency key before creating anything.
    listNotifications: jest.fn().mockResolvedValue([]),
  }

  const mockOrderService = {
    retrieveOrder: jest.fn().mockResolvedValue(mockOrder),
  }

  // The subscriber reads payment state from query.graph (the linked payment
  // collection), not order.payment_status. Default to a captured collection so
  // the happy-path tests send the confirmation.
  const paidGraphResult = {
    data: [{ id: 'order_abc', payment_collections: [{ status: 'completed', captured_amount: 49.99 }] }],
  }
  const mockQuery = {
    graph: jest.fn().mockResolvedValue(paidGraphResult),
  }

  const mockLogger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }

  const mockContainer = {
    resolve: jest.fn((key: string) => {
      if (key === 'notificationModuleService') return mockNotificationService
      if (key === 'orderModuleService') return mockOrderService
      if (key === 'query') return mockQuery
      if (key === 'logger') return mockLogger
      return undefined
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockOrderService.retrieveOrder.mockResolvedValue(mockOrder)
    mockQuery.graph.mockResolvedValue(paidGraphResult)
  })

  describe('config', () => {
    it('subscribes to the order.placed event', () => {
      expect(config.event).toBe('order.placed')
    })
  })

  describe('handler', () => {
    it('retrieves the order by data.id with the correct relations', async () => {
      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockOrderService.retrieveOrder).toHaveBeenCalledWith('order_abc', {
        relations: ['items', 'summary', 'shipping_address'],
      })
    })

    it('sends the confirmation with idempotency_key when payment is captured', async () => {
      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'buyer@example.com',
          channel: 'email',
          template: 'order-placed',
          idempotency_key: 'order-confirmed-order_abc',
          resource_id: 'order_abc',
          resource_type: 'order',
          trigger_type: 'order.placed',
          data: expect.objectContaining({
            emailOptions: expect.objectContaining({
              subject: 'Bestelling bevestigd | Inovix ORD-001',
              text: expect.stringContaining('ORD-001'),
            }),
            shippingAddress: mockShippingAddress,
            preview: 'Uw betaling is verwerkt | bestelling bevestigd',
          }),
        })
      )
    })

    it('defers to payment.captured when the payment collection is not yet paid', async () => {
      mockQuery.graph.mockResolvedValueOnce({
        data: [{ id: 'order_abc', payment_collections: [{ status: 'awaiting', captured_amount: 0 }] }],
      })

      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).not.toHaveBeenCalled()
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('deferring email to payment.captured')
      )
    })

    it('skips notification and warns when shipping_address is missing', async () => {
      mockOrderService.retrieveOrder.mockResolvedValueOnce({ ...mockOrder, shipping_address: null })

      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('order_abc')
      )
    })

    it('catches and logs errors from the notification service', async () => {
      const error = new Error('Email service down')
      mockNotificationService.createNotifications.mockRejectedValueOnce(error)

      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Email service down')
      )
    })
  })
})
