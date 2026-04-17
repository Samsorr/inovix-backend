jest.mock('../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    PAYMENT_FAILED: 'payment-failed',
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

const originalEnv = { ...process.env }

import paymentFailedHandler, { config } from '../payment-failed'

describe('payment-failed subscriber', () => {
  const mockNotificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
  }

  const mockQuery = {
    graph: jest.fn().mockResolvedValue({ data: [] }),
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
    process.env = { ...originalEnv, STOREFRONT_URL: 'https://inovix-peptides.com' }
    mockQuery.graph.mockResolvedValue({ data: [] })
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('config', () => {
    it('subscribes to the payment.failed event', () => {
      expect(config.event).toBe('payment.failed')
    })
  })

  describe('handler', () => {
    it('sends the email using customer_email from the event payload', async () => {
      await paymentFailedHandler({
        event: {
          data: {
            session_id: 'payses_1',
            transaction_id: 'tx_1',
            amount: 150,
            currency_code: 'EUR',
            customer_email: 'buyer@example.com',
            customer_name: 'Jan de Vries',
          },
        },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'buyer@example.com',
          channel: 'email',
          template: 'payment-failed',
          idempotency_key: 'payment-failed-tx_1',
          resource_type: 'payment_session',
          trigger_type: 'payment.failed',
          data: expect.objectContaining({
            amountFormatted: expect.stringMatching(/150/),
            currency: 'eur',
            retryUrl: 'https://inovix-peptides.com/winkelwagen',
            customerName: 'Jan de Vries',
            emailOptions: expect.objectContaining({
              subject: 'Betaling mislukt | Inovix',
              text: expect.stringContaining('Betaling mislukt'),
            }),
          }),
        })
      )
    })

    it('falls back to the cart email and shipping name when payload lacks them', async () => {
      mockQuery.graph.mockResolvedValueOnce({
        data: [
          {
            id: 'cart_1',
            email: 'cart@example.com',
            shipping_address: { first_name: 'Piet', last_name: 'Pieters' },
          },
        ],
      })

      await paymentFailedHandler({
        event: {
          data: {
            session_id: 'payses_1',
            transaction_id: 'tx_1',
            amount: 75,
            currency_code: 'EUR',
          },
        },
        container: mockContainer,
      } as any)

      expect(mockQuery.graph).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'cart',
          filters: { 'payment_collection.payment_sessions.id': 'payses_1' },
        })
      )
      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'cart@example.com',
          resource_id: 'cart_1',
          resource_type: 'cart',
          data: expect.objectContaining({
            customerName: 'Piet Pieters',
            retryUrl: 'https://inovix-peptides.com/winkelwagen?cart_id=cart_1',
          }),
        })
      )
    })

    it('skips notification and warns when no recipient email can be resolved', async () => {
      await paymentFailedHandler({
        event: {
          data: { session_id: 'payses_1', transaction_id: 'tx_1', amount: 10, currency_code: 'EUR' },
        },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no recipient email resolved')
      )
    })

    it('catches and logs errors from the notification service', async () => {
      const error = new Error('Email service down')
      mockNotificationService.createNotifications.mockRejectedValueOnce(error)

      await paymentFailedHandler({
        event: {
          data: {
            transaction_id: 'tx_1',
            amount: 10,
            currency_code: 'EUR',
            customer_email: 'buyer@example.com',
          },
        },
        container: mockContainer,
      } as any)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Email service down')
      )
    })
  })
})
