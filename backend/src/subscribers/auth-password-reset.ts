import { INotificationModuleService } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { BACKEND_URL, STOREFRONT_URL } from '../lib/constants'
import { EmailTemplates } from '../modules/email-notifications/templates'

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

  try {
    await notificationModuleService.createNotifications({
      to: email,
      channel: 'email',
      template: EmailTemplates.PASSWORD_RESET,
      data: {
        emailOptions: { subject },
        resetLink,
        actorType,
      },
    })
  } catch (error) {
    console.error('Error sending password reset notification:', error)
  }
}

export const config: SubscriberConfig = {
  event: 'auth.password_reset',
}
