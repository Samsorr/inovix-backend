import { Modules } from '@medusajs/framework/utils'
import {
  ICustomerModuleService,
  INotificationModuleService,
  Logger,
} from '@medusajs/framework/types'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import { Sentry } from '../lib/instrument'

const STOREFRONT_URL =
  process.env.STOREFRONT_URL?.replace(/\/$/, '') ?? 'https://inovix-peptides.com'

export default async function customerCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const notificationModuleService: INotificationModuleService =
    container.resolve(Modules.NOTIFICATION)
  const customerModuleService: ICustomerModuleService = container.resolve(
    Modules.CUSTOMER
  )
  const logger: Logger = container.resolve('logger')

  try {
    const customer = await customerModuleService.retrieveCustomer(data.id)

    if (!customer.email) {
      logger.warn(
        `customer.created: customer ${data.id} has no email; skipping notification`
      )
      return
    }

    const replyTo = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL
    const greetingName = customer.first_name?.trim() || customer.email
    const productsUrl = `${STOREFRONT_URL}/products`
    const accountUrl = `${STOREFRONT_URL}/account`

    const textBody =
      `Welkom bij Inovix\n\n` +
      `Beste ${greetingName},\n\n` +
      `Bedankt voor het aanmaken van uw account bij Inovix. U heeft nu ` +
      `toegang tot ons volledige assortiment onderzoekspeptiden, kunt eerdere ` +
      `bestellingen inzien en verzendgegevens beheren.\n\n` +
      `Hoe te bestellen:\n` +
      `1. Bekijk ons assortiment: ${productsUrl}\n` +
      `2. Voeg producten toe aan uw winkelwagen en ga naar checkout.\n` +
      `3. Bevestig dat de bestelling uitsluitend voor onderzoek is en rond ` +
      `de betaling af.\n\n` +
      `Wij verzenden GMP gecertificeerde, HPLC getoetste peptiden door de ` +
      `gehele EU. Standaard met tracking en discrete verpakking.\n\n` +
      `Account beheren: ${accountUrl}\n\n` +
      `Uitsluitend voor onderzoeksdoeleinden. Producten van Inovix zijn ` +
      `bedoeld voor in-vitro laboratorium onderzoek en niet geschikt voor ` +
      `menselijke of dierlijke consumptie, medische of cosmetische ` +
      `toepassingen.`

    await notificationModuleService.createNotifications({
      to: customer.email,
      channel: 'email',
      template: EmailTemplates.CUSTOMER_WELCOME,
      data: {
        emailOptions: {
          ...(replyTo ? { replyTo } : {}),
          subject: 'Welkom bij Inovix',
          text: textBody,
        },
        firstName: customer.first_name ?? null,
        email: customer.email,
        storefrontUrl: STOREFRONT_URL,
        preview: 'Welkom bij Inovix',
      },
    })
  } catch (error) {
    logger.error(
      `customer.created: failed to send notification for ${data.id}: ${(error as Error).message}`
    )
    Sentry.captureException(error, {
      tags: { subscriber: 'customer.created' },
      extra: { customerId: data.id },
    })
  }
}

export const config: SubscriberConfig = {
  event: 'customer.created',
}
