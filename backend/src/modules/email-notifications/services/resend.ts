import { Logger, NotificationTypes } from '@medusajs/framework/types'
import { AbstractNotificationProviderService, MedusaError } from '@medusajs/framework/utils'
import { Resend, CreateEmailOptions } from 'resend'
import { ReactNode } from 'react'
import { generateEmailTemplate } from '../templates'

type InjectedDependencies = {
  logger: Logger
}

interface ResendServiceConfig {
  apiKey: string
  from: string
}

export interface ResendNotificationServiceOptions {
  api_key: string
  from: string
}

type NotificationEmailOptions = Omit<
  CreateEmailOptions,
  'to' | 'from' | 'react' | 'html' | 'attachments'
>

/**
 * Brand separation is a hard rule: Inovix and Tencore have SEPARATE Resend
 * accounts and support addresses. A stray `SUPPORT_EMAIL=info@tencore.nl` in a
 * local .env once put `Reply-To: info@tencore.nl` on a real Inovix order
 * confirmation, which would have pointed an Inovix buyer at the other brand.
 * Mirrors the `metadataIsClean` guard on the payment side: refuse the send
 * rather than leak the wrong brand.
 */
export function assertNoTencoreAddress(label: string, value: unknown): void {
  if (typeof value === 'string' && /tencore/i.test(value)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Refusing to send an Inovix email: ${label} is a Tencore address ("${value}")`
    )
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoTencoreAddress(label, entry)
  }
}

/**
 * Service to handle email notifications using the Resend API.
 */
export class ResendNotificationService extends AbstractNotificationProviderService {
  static identifier = "RESEND_NOTIFICATION_SERVICE"
  protected config_: ResendServiceConfig // Configuration for Resend API
  protected logger_: Logger // Logger for error and event logging
  protected resend: Resend // Instance of the Resend API client

  constructor({ logger }: InjectedDependencies, options: ResendNotificationServiceOptions) {
    super()
    this.config_ = {
      apiKey: options.api_key,
      from: options.from
    }
    this.logger_ = logger
    this.resend = new Resend(this.config_.apiKey)
  }

  async send(
    notification: NotificationTypes.ProviderSendNotificationDTO
  ): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    if (!notification) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No notification information provided`)
    }
    if (notification.channel === 'sms') {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `SMS notification not supported`)
    }

    // Generate the email content using the template
    let emailContent: ReactNode

    try {
      emailContent = generateEmailTemplate(notification.template, notification.data)
    } catch (error) {
      if (error instanceof MedusaError) {
        throw error // Re-throw MedusaError for invalid template data
      }
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to generate email content for template: ${notification.template}`
      )
    }

    const emailOptions = notification.data.emailOptions as NotificationEmailOptions

    // Compose the message body to send via API to Resend
    const message: CreateEmailOptions = {
      to: notification.to,
      from: notification.from?.trim() ?? this.config_.from,
      react: emailContent,
      subject: emailOptions.subject ?? 'You have a new notification',
      headers: emailOptions.headers,
      replyTo: emailOptions.replyTo,
      cc: emailOptions.cc,
      bcc: emailOptions.bcc,
      tags: emailOptions.tags,
      text: emailOptions.text,
      attachments: Array.isArray(notification.attachments)
        ? notification.attachments.map((attachment) => ({
            content: attachment.content,
            filename: attachment.filename,
            content_type: attachment.content_type,
            disposition: attachment.disposition ?? 'attachment',
            id: attachment.id ?? undefined
          }))
        : undefined,
      scheduledAt: emailOptions.scheduledAt
    }

    assertNoTencoreAddress('from', message.from)
    assertNoTencoreAddress('to', message.to)
    assertNoTencoreAddress('replyTo', message.replyTo)

    // Send the email via Resend.
    //
    // CRITICAL: `resend.emails.send()` does NOT throw on an API rejection. It
    // resolves with `{ data: null, error: { name, message } }` for every 4xx/5xx
    // (403 not_authorized, 422 validation_error, 429 rate_limit_exceeded) and
    // for network failures ("application_error"). Awaiting it and declaring
    // success is what silently dropped order confirmations in the 2026-07-21
    // outage. The result MUST be inspected. It only rejects when the React
    // template itself throws during `renderAsync`, which is the catch below.
    let result: Awaited<ReturnType<typeof this.resend.emails.send>>
    try {
      result = await this.resend.emails.send(message)
    } catch (error) {
      // Thrown path: template render error, or a bug in the SDK. Keep the real
      // message | the old code read `error.code` / `error.response.body.errors`
      // which are both undefined here and produced "undefined - unknown error".
      const errorCode = (error as any)?.code
      const responseError = (error as any)?.response?.body?.errors?.[0]
      const detail =
        responseError?.message ?? (error as Error)?.message ?? 'unknown error'
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to send "${notification.template}" email to ${notification.to} via Resend: ${errorCode ?? 'render_error'} - ${detail}`
      )
    }

    const { data, error } = result ?? { data: null, error: null }

    if (error) {
      // A non-null `error` is a failure, full stop. Throwing makes the
      // notification module stamp the row `status: failure` and propagates to
      // the subscriber's catch, which reports to Sentry.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to send "${notification.template}" email to ${notification.to} via Resend: ${error.name ?? 'unknown_error'} - ${error.message ?? 'unknown error'}`
      )
    }

    this.logger_.log(
      `Successfully sent "${notification.template}" email to ${notification.to} via Resend`
    )

    // Returning the Resend message id makes the notification row auditable:
    // Medusa writes it to `notification.external_id`. It was `{}` before, which
    // is why external_id is NULL on every historical row.
    return data?.id ? { id: data.id } : {}
  }
}
