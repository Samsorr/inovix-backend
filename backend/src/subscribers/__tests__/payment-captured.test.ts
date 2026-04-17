jest.mock('../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    ORDER_PLACED: 'order-placed',
  },
}))

jest.mock('@medusajs/framework/utils', () => ({
  ContainerRegistrationKeys: {
    QUERY: 'query',
    LOGGER: 'logger',
  },
  Modules: {
    NOTIFICATION: 'notificationModuleService',
  },
}))

import paymentCapturedHandler, { config } from '../payment-captured'

describe('payment-captured subscriber', () => {
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
    items: [
      { id: 'item-1', title: 'BPC-157', product_title: 'Peptide', quantity: 1, unit_price: 49.99 },
    ],
    shipping_address: mockShippingAddress,
    summary: { raw_current_order_total: { value: 49.99 } },
    created_at: new Date().toISOString(),
  }

  const mockNotificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
  }

  const mockQuery = {
    graph: jest.fn().mockResolvedValue({
      data: [{ id: 'pay_1', payment_collection: { id: 'pc_1', order: mockOrder } }],
    }),
  }

  const mockLogger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }

  const mockContainer = {
    resolve: jest.fn((key: string) => {
      if (key === 'notificationModuleService') return mockNotificationService
      if (key === 'query') return mockQuery
      if (key === 'logger') return mockLogger
      return undefined
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockQuery.graph.mockResolvedValue({
      data: [{ id: 'pay_1', payment_collection: { id: 'pc_1', order: mockOrder } }],
    })
  })

  describe('config', () => {
    it('subscribes to the payment.captured event', () => {
      expect(config.event).toBe('payment.captured')
    })
  })

  describe('handler', () => {
    it('queries the payment graph to resolve the order', async () => {
      await paymentCapturedHandler({
        event: { data: { id: 'pay_1' } },
        container: mockContainer,
      } as any)

      expect(mockQuery.graph).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'payment',
          filters: { id: 'pay_1' },
          fields: expect.arrayContaining([
            'id',
            'payment_collection.order.id',
            'payment_collection.order.shipping_address.*',
          ]),
        })
      )
    })

    it('sends the confirmation with idempotency_key scoped to the order', async () => {
      await paymentCapturedHandler({
        event: { data: { id: 'pay_1' } },
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
          trigger_type: 'payment.captured',
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

    it('skips notification and warns when no order is linked yet', async () => {
      mockQuery.graph.mockResolvedValueOnce({
        data: [{ id: 'pay_1', payment_collection: { id: 'pc_1', order: null } }],
      })

      await paymentCapturedHandler({
        event: { data: { id: 'pay_1' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no order found for payment pay_1')
      )
    })

    it('skips notification and warns when shipping_address is missing', async () => {
      mockQuery.graph.mockResolvedValueOnce({
        data: [
          {
            id: 'pay_1',
            payment_collection: { id: 'pc_1', order: { ...mockOrder, shipping_address: null } },
          },
        ],
      })

      await paymentCapturedHandler({
        event: { data: { id: 'pay_1' } },
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

      await paymentCapturedHandler({
        event: { data: { id: 'pay_1' } },
        container: mockContainer,
      } as any)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Email service down')
      )
    })
  })
})
