import type { EmailLocale } from '../../lib/email-locale'
import {
  ORDER_PLACED_TEXT_I18N,
  toEmailNumber,
} from '../../modules/email-notifications/templates/email-i18n'

type Addressish = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  postal_code?: string | null
  city?: string | null
  country_code?: string | null
}

type Itemish = {
  product_title?: string | null
  variant_title?: string | null
  quantity?: number | null
  unit_price?: number | null
}

type Orderish = {
  display_id: string | number
  currency_code?: string | null
  items?: Itemish[] | null
  summary?: { raw_current_order_total?: { value?: number | string | null } | null } | null
}

export function buildOrderConfirmationText(
  order: Orderish,
  addr: Addressish,
  locale: EmailLocale = 'nl'
): string {
  const t = ORDER_PLACED_TEXT_I18N[locale] ?? ORDER_PLACED_TEXT_I18N.nl
  const currency = (order.currency_code ?? 'EUR').toUpperCase()
  const itemsText = (order.items ?? [])
    .map((item) => {
      const variant = item.variant_title ? ` | ${item.variant_title}` : ''
      const lineTotal = (
        toEmailNumber(item.unit_price) * toEmailNumber(item.quantity)
      ).toFixed(2)
      return `- ${item.product_title}${variant} × ${item.quantity} (${lineTotal} ${currency})`
    })
    .join('\n')
  const totalValue = order.summary?.raw_current_order_total?.value
  const totalText =
    totalValue != null ? `${toEmailNumber(totalValue).toFixed(2)} ${currency}` : ''
  const addrLines = [
    `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim(),
    addr.company,
    [addr.address_1, addr.address_2].filter(Boolean).join(', '),
    `${addr.postal_code ?? ''} ${addr.city ?? ''}`.trim(),
    addr.country_code?.toUpperCase(),
  ]
    .filter(Boolean)
    .join('\n')

  return (
    `${t.title}\n` +
    `${t.orderNumber} #${order.display_id}\n\n` +
    `${t.greeting} ${addr.first_name ?? ''} ${addr.last_name ?? ''},\n\n` +
    `${t.body}\n\n` +
    `${t.yourOrder}\n${itemsText}\n\n` +
    (totalText ? `${t.total}: ${totalText} (${t.inclVat})\n\n` : '') +
    `${t.shippingAddress}\n${addrLines}\n\n` +
    t.disclaimer
  )
}
