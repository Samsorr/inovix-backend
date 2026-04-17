import { INotificationModuleService, IUserModuleService, Logger } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { BACKEND_URL } from '../lib/constants'
import { EmailTemplates } from '../modules/email-notifications/templates'

export default async function userInviteHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const notificationModuleService: INotificationModuleService = container.resolve(
    Modules.NOTIFICATION,
  )
  const userModuleService: IUserModuleService = container.resolve(Modules.USER)
  const logger: Logger = container.resolve('logger')

  try {
    const invite = await userModuleService.retrieveInvite(data.id)
    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL

    await notificationModuleService.createNotifications({
      to: invite.email,
      channel: 'email',
      template: EmailTemplates.INVITE_USER,
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: "You've been invited to the Inovix admin",
        },
        inviteLink: `${BACKEND_URL}/app/invite?token=${encodeURIComponent(invite.token)}`,
        preview: 'The Inovix admin dashboard awaits...',
      },
    })
  } catch (error) {
    logger.error(`invite.created: failed to send notification: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: ['invite.created', 'invite.resent']
}
