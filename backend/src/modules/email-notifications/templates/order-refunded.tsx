import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderAddressDTO } from '@medusajs/framework/types'

export const ORDER_REFUNDED = 'order-refunded'

interface OrderSummary {
  id: string
  display_id: string
  email: string
  currency_code: string
}

export interface OrderRefundedTemplateProps {
  order: OrderSummary
  shippingAddress: OrderAddressDTO
  refundAmount: number
  refundedAt?: string | Date | null
  reason?: string | null
  preview?: string
}

export const isOrderRefundedTemplateData = (
  data: any
): data is OrderRefundedTemplateProps =>
  typeof data.order === 'object' &&
  typeof data.shippingAddress === 'object' &&
  typeof data.refundAmount === 'number'

const CURRENCY_LOCALE_BY_CODE: Record<string, string> = {
  eur: 'nl-NL',
  usd: 'en-US',
  gbp: 'en-GB',
}

function formatMoney(value: number, currencyCode: string) {
  const locale = CURRENCY_LOCALE_BY_CODE[currencyCode?.toLowerCase()] ?? 'nl-NL'
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode?.toUpperCase() || 'EUR',
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currencyCode?.toUpperCase() ?? ''}`.trim()
  }
}

function formatDateNL(date: string | Date) {
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(date))
  } catch {
    return String(date)
  }
}

export const OrderRefundedTemplate: React.FC<OrderRefundedTemplateProps> & {
  PreviewProps: OrderRefundedTemplateProps
} = ({
  order,
  shippingAddress,
  refundAmount,
  refundedAt,
  reason,
  preview = 'Uw terugstorting is verwerkt',
}) => {
  const currency = order.currency_code

  return (
    <Base preview={preview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Uw terugstorting is verwerkt
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          Ordernummer #{order.display_id}
          {refundedAt ? ` | ${formatDateNL(refundedAt)}` : ''}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          Beste {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          We bevestigen dat de terugstorting voor uw bestelling is verwerkt.
          Het bedrag staat over enkele werkdagen op uw rekening, afhankelijk
          van uw bank of kaartuitgever.
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Row>
          <Column className="text-black text-[14px] font-semibold" align="left">
            Teruggestort bedrag
          </Column>
          <Column
            className="text-black text-[14px] font-semibold whitespace-nowrap"
            align="right"
            width="90"
          >
            {formatMoney(refundAmount, currency)}
          </Column>
        </Row>
        {reason ? (
          <Text className="text-[#666666] text-[12px] leading-[18px] mt-[8px] mb-0">
            Reden: {reason}
          </Text>
        ) : null}
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          De terugstorting wordt naar dezelfde betaalmethode gestuurd waarmee
          u oorspronkelijk heeft betaald. De verwerkingstijd is doorgaans 5
          tot 10 werkdagen.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] mt-[12px]">
          Heeft u na 10 werkdagen nog niets ontvangen, of klopt het bedrag
          niet, neem dan contact met ons op zodat we het direct kunnen
          oplossen.
        </Text>
      </Section>
    </Base>
  )
}

OrderRefundedTemplate.PreviewProps = {
  order: {
    id: 'test-order-id',
    display_id: 'ORD-123',
    email: 'test@example.com',
    currency_code: 'EUR',
  },
  shippingAddress: {
    first_name: 'Jan',
    last_name: 'de Vries',
    address_1: 'Voorbeeldstraat 12',
    address_2: '',
    company: '',
    city: 'Amsterdam',
    province: '',
    postal_code: '1011 AB',
    country_code: 'NL',
  } as OrderAddressDTO,
  refundAmount: 90,
  refundedAt: new Date().toISOString(),
  reason: 'Klantverzoek',
}

export default OrderRefundedTemplate
