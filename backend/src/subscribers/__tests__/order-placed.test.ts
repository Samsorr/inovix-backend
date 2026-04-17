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

  const mockOrderService = {
    retrieveOrder: jest.fn().mockResolvedValue(mockOrder),
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
      if (key === 'logger') return mockLogger
      return undefined
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockOrderService.retrieveOrder.mockResolvedValue(mockOrder)
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

    it('uses the loaded shipping_address relation directly', async () => {
      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shippingAddress: mockShippingAddress,
          }),
        })
      )
    })

    it('creates a notification with correct email, template, order data, and shippingAddress', async () => {
      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith({
        to: 'buyer@example.com',
        channel: 'email',
        template: 'order-placed',
        data: {
          emailOptions: {
            subject: 'Bestelling ontvangen | Inovix ORD-001',
          },
          order: mockOrder,
          shippingAddress: mockShippingAddress,
          preview: 'Bedankt voor uw bestelling bij Inovix',
        },
      })
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
