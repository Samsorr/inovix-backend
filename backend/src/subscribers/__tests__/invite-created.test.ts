jest.mock('../../lib/constants', () => ({
  BACKEND_URL: 'https://api.example.com',
}))

jest.mock('../../modules/email-notifications/templates', () => ({
  EmailTemplates: {
    INVITE_USER: 'invite-user',
    ORDER_PLACED: 'order-placed',
  },
}))

jest.mock('@medusajs/framework/utils', () => ({
  Modules: {
    NOTIFICATION: 'notificationModuleService',
    USER: 'userModuleService',
  },
}))

import userInviteHandler, { config } from '../invite-created'

describe('invite-created subscriber', () => {
  const mockInvite = {
    id: 'invite_123',
    email: 'newadmin@example.com',
    token: 'token_abc123',
  }

  const mockNotificationService = {
    createNotifications: jest.fn().mockResolvedValue(undefined),
  }

  const mockUserService = {
    retrieveInvite: jest.fn().mockResolvedValue(mockInvite),
  }

  const mockLogger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }

  const mockContainer = {
    resolve: jest.fn((key: string) => {
      if (key === 'notificationModuleService') return mockNotificationService
      if (key === 'userModuleService') return mockUserService
      if (key === 'logger') return mockLogger
      return undefined
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('config', () => {
    it('subscribes to invite.created and invite.resent events', () => {
      expect(config.event).toEqual(['invite.created', 'invite.resent'])
    })
  })

  describe('handler', () => {
    it('retrieves the invite by data.id', async () => {
      await userInviteHandler({
        event: { data: { id: 'invite_123' } },
        container: mockContainer,
      } as any)

      expect(mockUserService.retrieveInvite).toHaveBeenCalledWith('invite_123')
    })

    it('creates a notification with the correct email, template, and data', async () => {
      await userInviteHandler({
        event: { data: { id: 'invite_123' } },
        container: mockContainer,
      } as any)

      expect(mockNotificationService.createNotifications).toHaveBeenCalledWith({
        to: 'newadmin@example.com',
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: {
            subject: "You've been invited to the Inovix admin",
            text: expect.stringContaining(
              'https://api.example.com/app/invite?token=token_abc123'
            ),
          },
          inviteLink: 'https://api.example.com/app/invite?token=token_abc123',
          preview: 'The Inovix admin dashboard awaits...',
        },
      })
    })

    it('catches and logs errors from the notification service', async () => {
      const error = new Error('Notification service unavailable')
      mockNotificationService.createNotifications.mockRejectedValueOnce(error)

      await userInviteHandler({
        event: { data: { id: 'invite_123' } },
        container: mockContainer,
      } as any)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Notification service unavailable')
      )
    })
  })
})
