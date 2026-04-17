import { INotificationModuleService, Logger } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { BACKEND_URL, STOREFRONT_URL } from '../lib/constants'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'

type PasswordResetEventData = {
  entity_id: string
  actor_type: 'customer' | 'user' | string
  token: string
}

export default async function authPasswordResetHandler({
  event: { data },
  container,
}: SubscriberArgs<PasswordResetEventData>) {
  const notificationModuleService: INotificationModuleService = container.resolve(
    Modules.NOTIFICATION
  )
  const logger: Logger = container.resolve('logger')

  const { entity_id: email, actor_type, token } = data

  const isCustomer = actor_type === 'customer'
  const actorType: 'customer' | 'user' = isCustomer ? 'customer' : 'user'

  const baseUrl = isCustomer ? STOREFRONT_URL : BACKEND_URL
  const resetPath = isCustomer ? '/account/wachtwoord-herstellen' : '/app/reset-password'
  const resetLink =
    `${baseUrl}${resetPath}?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}`

  const subject = isCustomer
    ? 'Herstel uw Inovix-wachtwoord'
    : 'Reset your Inovix admin password'

  const textBody = isCustomer
    ? `Er is een verzoek ingediend om het wachtwoord van uw Inovix-account te herstellen.\n\n` +
      `Klik op de onderstaande link om een nieuw wachtwoord in te stellen. Deze link verloopt over 15 minuten.\n\n` +
      `${resetLink}\n\n` +
      `Heeft u geen wachtwoordherstel aangevraagd? Dan kunt u deze e-mail negeren, uw wachtwoord blijft ongewijzigd.`
    : `A request was made to reset the password on your Inovix admin account.\n\n` +
      `Set a new password via this link (expires in 15 minutes):\n\n` +
      `${resetLink}\n\n` +
      `Didn't request a password reset? You can ignore this email, your password will remain unchanged.`

  try {
    await notificationModuleService.createNotifications({
      to: email,
      channel: 'email',
      template: EmailTemplates.PASSWORD_RESET,
      data: {
        emailOptions: { subject, text: textBody },
        resetLink,
        actorType,
      },
    })
  } catch (error) {
    logger.error(`auth.password_reset: failed to send notification: ${(error as Error).message}`)
    Sentry.captureException(error, {
      tags: { subscriber: 'auth.password_reset', actor_type: actor_type },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'auth.password_reset',
}
