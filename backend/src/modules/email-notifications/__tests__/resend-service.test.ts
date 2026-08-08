// The real `resend@4.0.1` resolves with `{ data, error }` on EVERY outcome and
// never rejects on an API failure. The mock must model that exact shape or the
// test proves nothing.
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: 'email_123' }, error: null }),
    },
  })),
}), { virtual: true })

jest.mock('@medusajs/framework/utils', () => ({
  AbstractNotificationProviderService: class {},
  MedusaError: class MedusaError extends Error {
    static Types = { INVALID_DATA: 'invalid_data', UNEXPECTED_STATE: 'unexpected_state' }
    type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  },
}))

jest.mock('../templates', () => ({
  generateEmailTemplate: jest.fn().mockReturnValue('<div>Email</div>'),
}))

import { ResendNotificationService } from '../services/resend'
import { generateEmailTemplate } from '../templates'
import { MedusaError } from '@medusajs/framework/utils'

const mockLogger = {
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

function createService() {
  return new ResendNotificationService(
    { logger: mockLogger as any },
    { api_key: 'test_api_key', from: 'noreply@example.com' }
  )
}

describe('ResendNotificationService', () => {
  let service: ResendNotificationService

  beforeEach(() => {
    service = createService()
  })

  describe('send', () => {
    it('throws when notification is null', async () => {
      await expect(service.send(null as any)).rejects.toThrow(
        'No notification information provided'
      )
    })

    it('throws when notification is undefined', async () => {
      await expect(service.send(undefined as any)).rejects.toThrow(
        'No notification information provided'
      )
    })

    it('throws when channel is "sms"', async () => {
      const notification = {
        to: '+1234567890',
        channel: 'sms',
        template: 'invite-user',
        data: { emailOptions: {} },
      }

      await expect(service.send(notification as any)).rejects.toThrow(
        'SMS notification not supported'
      )
    })

    it('calls generateEmailTemplate with the correct template key and data', async () => {
      const data = {
        emailOptions: { subject: 'Test Subject' },
        inviteLink: 'https://example.com/invite',
      }
      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data,
      }

      await service.send(notification as any)

      expect(generateEmailTemplate).toHaveBeenCalledWith('invite-user', data)
    })

    it('sends email via Resend with correct to, from, subject, and react content', async () => {
      const notification = {
        to: 'user@example.com',
        from: 'sender@example.com',
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: { subject: 'Welcome!' },
        },
      }

      await service.send(notification as any)

      // Access the mock Resend instance to verify the send call
      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          from: 'sender@example.com',
          subject: 'Welcome!',
          react: '<div>Email</div>',
        })
      )
    })

    it('uses the config from address when notification.from is undefined', async () => {
      const notification = {
        to: 'user@example.com',
        from: undefined,
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: { subject: 'Hello' },
        },
      }

      await service.send(notification as any)

      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@example.com',
        })
      )
    })

    it('uses the config from address when notification.from is null', async () => {
      const notification = {
        to: 'user@example.com',
        from: null,
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: { subject: 'Hello' },
        },
      }

      await service.send(notification as any)

      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@example.com',
        })
      )
    })

    it('handles custom emailOptions (replyTo, cc, bcc, tags)', async () => {
      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: {
            subject: 'Test',
            replyTo: 'reply@example.com',
            cc: 'cc@example.com',
            bcc: 'bcc@example.com',
            tags: [{ name: 'category', value: 'invite' }],
          },
        },
      }

      await service.send(notification as any)

      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          replyTo: 'reply@example.com',
          cc: 'cc@example.com',
          bcc: 'bcc@example.com',
          tags: [{ name: 'category', value: 'invite' }],
        })
      )
    })

    it('handles attachments conversion', async () => {
      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: {
          emailOptions: { subject: 'With Attachment' },
        },
        attachments: [
          {
            content: 'base64content',
            filename: 'report.pdf',
            content_type: 'application/pdf',
            disposition: 'attachment',
            id: 'att_1',
          },
        ],
      }

      await service.send(notification as any)

      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              content: 'base64content',
              filename: 'report.pdf',
              content_type: 'application/pdf',
              disposition: 'attachment',
              id: 'att_1',
            },
          ],
        })
      )
    })

    it('throws MedusaError when generateEmailTemplate throws', async () => {
      ;(generateEmailTemplate as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Template rendering failed')
      })

      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'unknown-template',
        data: { emailOptions: {} },
      }

      await expect(service.send(notification as any)).rejects.toThrow(
        'Failed to generate email content for template: unknown-template'
      )
    })

    it('re-throws MedusaError from generateEmailTemplate directly', async () => {
      const medusaError = new MedusaError(
        (MedusaError as any).Types.INVALID_DATA,
        'Invalid template data'
      )
      ;(generateEmailTemplate as jest.Mock).mockImplementationOnce(() => {
        throw medusaError
      })

      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: { emailOptions: {} },
      }

      await expect(service.send(notification as any)).rejects.toThrow('Invalid template data')
    })

    it('throws MedusaError when the SDK itself rejects (template render failure)', async () => {
      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      resendInstance.emails.send.mockRejectedValueOnce(
        new TypeError("Cannot read properties of undefined (reading 'raw_current_order_total')")
      )

      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'order-placed',
        data: { emailOptions: { subject: 'Test' } },
      }

      // The real TypeError message must survive; it used to be discarded and
      // reported as "undefined - unknown error".
      await expect(service.send(notification as any)).rejects.toThrow(
        /raw_current_order_total/
      )
    })

    // ---------------------------------------------------------------------
    // The CRITICAL regression: resend@4.x resolves (never rejects) on 403,
    // 422, 429 and network failures. Reporting those as success is what burned
    // the idempotency key and silently dropped order confirmations.
    // ---------------------------------------------------------------------
    describe('Resend { data: null, error } responses', () => {
      const notification = {
        to: 'klant@example.nl',
        channel: 'email',
        template: 'order-placed',
        data: { emailOptions: { subject: 'Bestelling bevestigd' } },
      }

      function mockResendError(error: { name: string; message: string }) {
        const { Resend } = require('resend')
        const resendInstance = Resend.mock.results[0].value
        resendInstance.emails.send.mockResolvedValueOnce({ data: null, error })
        return resendInstance
      }

      it.each([
        ['not_authorized', 'This API key is restricted to only send emails'],
        ['validation_error', 'The from address is not verified'],
        ['rate_limit_exceeded', 'Too many requests'],
        ['application_error', 'Unable to fetch data. The request could not be resolved.'],
      ])('throws instead of reporting success for %s', async (name, message) => {
        mockResendError({ name, message })

        await expect(service.send(notification as any)).rejects.toThrow(
          new RegExp(`Failed to send "order-placed" email to klant@example.nl via Resend: ${name} - `)
        )
      })

      it('does NOT log a success line when Resend returns an error', async () => {
        mockResendError({ name: 'not_authorized', message: 'nope' })

        await expect(service.send(notification as any)).rejects.toThrow()

        expect(mockLogger.log).not.toHaveBeenCalled()
      })
    })

    it('refuses to send when the reply-to is a Tencore address', async () => {
      const notification = {
        to: 'klant@example.nl',
        channel: 'email',
        template: 'order-placed',
        data: { emailOptions: { subject: 'Hi', replyTo: 'info@tencore.nl' } },
      }

      await expect(service.send(notification as any)).rejects.toThrow(
        /replyTo is a Tencore address/
      )

      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      expect(resendInstance.emails.send).not.toHaveBeenCalled()
    })

    it('refuses to send when the from address is a Tencore address', async () => {
      const notification = {
        to: 'klant@example.nl',
        from: 'Tencore <info@tencore.nl>',
        channel: 'email',
        template: 'order-placed',
        data: { emailOptions: { subject: 'Hi' } },
      }

      await expect(service.send(notification as any)).rejects.toThrow(
        /from is a Tencore address/
      )
    })

    it('logs a success message after sending', async () => {
      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: { emailOptions: { subject: 'Hello' } },
      }

      await service.send(notification as any)

      expect(mockLogger.log).toHaveBeenCalledWith(
        'Successfully sent "invite-user" email to user@example.com via Resend'
      )
    })

    it('returns the Resend message id so external_id gets populated', async () => {
      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: { emailOptions: { subject: 'Hello' } },
      }

      const result = await service.send(notification as any)

      // Medusa writes this to notification.external_id. Returning `{}` is why
      // external_id was NULL on all 106 production rows.
      expect(result).toEqual({ id: 'email_123' })
    })

    it('returns an empty object when Resend answers without an id', async () => {
      const { Resend } = require('resend')
      const resendInstance = Resend.mock.results[0].value
      resendInstance.emails.send.mockResolvedValueOnce({ data: null, error: null })

      const notification = {
        to: 'user@example.com',
        channel: 'email',
        template: 'invite-user',
        data: { emailOptions: { subject: 'Hello' } },
      }

      expect(await service.send(notification as any)).toEqual({})
    })
  })
})
