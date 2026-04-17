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

export function buildOrderConfirmationText(order: Orderish, addr: Addressish): string {
  const currency = (order.currency_code ?? 'EUR').toUpperCase()
  const itemsText = (order.items ?? [])
    .map((item) => {
      const variant = item.variant_title ? ` | ${item.variant_title}` : ''
      const lineTotal = (Number(item.unit_price ?? 0) * Number(item.quantity ?? 0)).toFixed(2)
      return `- ${item.product_title}${variant} × ${item.quantity} (${lineTotal} ${currency})`
    })
    .join('\n')
  const totalValue = order.summary?.raw_current_order_total?.value
  const totalText = totalValue != null ? `${Number(totalValue).toFixed(2)} ${currency}` : ''
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
    `Bedankt voor uw bestelling bij Inovix\n` +
    `Ordernummer #${order.display_id}\n\n` +
    `Beste ${addr.first_name ?? ''} ${addr.last_name ?? ''},\n\n` +
    `Uw betaling is verwerkt en de bestelling is bevestigd. Zodra uw bestelling ` +
    `verzonden is, ontvangt u een aparte e-mail met de trackinggegevens.\n\n` +
    `Uw bestelling:\n${itemsText}\n\n` +
    (totalText ? `Totaal: ${totalText} (incl. btw en verzendkosten)\n\n` : '') +
    `Verzendadres:\n${addrLines}\n\n` +
    `Uitsluitend voor onderzoeksdoeleinden. Producten van Inovix zijn bedoeld voor ` +
    `in-vitro laboratorium onderzoek en niet geschikt voor menselijke of dierlijke ` +
    `consumptie, medische of cosmetische toepassingen.`
  )
}
