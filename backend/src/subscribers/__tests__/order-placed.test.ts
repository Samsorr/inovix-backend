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
    shipping_address: { id: 'addr_1' },
    summary: { raw_current_order_total: { value: 49.99 } },
    created_at: new Date().toISOString(),
  }

  const mockOrderAddressService = {
    retrieve: jest.fn().mockResolvedValue(mockShippingAddress),
  }

  const mockNotificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
  }

  const mockOrderService = {
    retrieveOrder: jest.fn().mockResolvedValue(mockOrder),
    orderAddressService_: mockOrderAddressService,
  }

  const mockContainer = {
    resolve: jest.fn((key: string) => {
      if (key === 'notificationModuleService') return mockNotificationService
      if (key === 'orderModuleService') return mockOrderService
      return undefined
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
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

    it('retrieves the shipping address using the order shipping_address id', async () => {
      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(mockOrderAddressService.retrieve).toHaveBeenCalledWith('addr_1')
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
            replyTo: 'info@example.com',
            subject: 'Your order has been placed',
          },
          order: mockOrder,
          shippingAddress: mockShippingAddress,
          preview: 'Thank you for your order!',
        },
      })
    })

    it('catches and logs errors from the notification service', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()
      const error = new Error('Email service down')
      mockNotificationService.createNotifications.mockRejectedValueOnce(error)

      await orderPlacedHandler({
        event: { data: { id: 'order_abc' } },
        container: mockContainer,
      } as any)

      expect(consoleSpy).toHaveBeenCalledWith(
        'Error sending order confirmation notification:',
        error
      )
      consoleSpy.mockRestore()
    })
  })
})
