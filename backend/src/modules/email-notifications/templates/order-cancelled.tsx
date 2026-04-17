import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderDTO, OrderAddressDTO } from '@medusajs/framework/types'

export const ORDER_CANCELLED = 'order-cancelled'

interface OrderCancelledPreviewProps {
  order: OrderDTO & {
    display_id: string
    summary: { raw_current_order_total: { value: number } }
  }
  shippingAddress: OrderAddressDTO
}

export interface OrderCancelledTemplateProps {
  order: OrderDTO & {
    display_id: string
    summary: { raw_current_order_total: { value: number } }
  }
  shippingAddress: OrderAddressDTO
  preview?: string
}

export const isOrderCancelledTemplateData = (
  data: any
): data is OrderCancelledTemplateProps =>
  typeof data.order === 'object' && typeof data.shippingAddress === 'object'

const CURRENCY_LOCALE_BY_CODE: Record<string, string> = {
  eur: 'nl-NL',
  usd: 'en-US',
  gbp: 'en-GB',
}

function formatMoney(value: number | string | undefined, currencyCode: string) {
  const numeric = typeof value === 'string' ? Number(value) : (value ?? 0)
  const locale = CURRENCY_LOCALE_BY_CODE[currencyCode?.toLowerCase()] ?? 'nl-NL'
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode?.toUpperCase() || 'EUR',
    }).format(numeric)
  } catch {
    return `${numeric.toFixed(2)} ${currencyCode?.toUpperCase() ?? ''}`.trim()
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

export const OrderCancelledTemplate: React.FC<OrderCancelledTemplateProps> & {
  PreviewProps: OrderCancelledPreviewProps
} = ({
  order,
  shippingAddress,
  preview = 'Uw bestelling is geannuleerd',
}) => {
  const currency = order.currency_code
  const refundTotal = order.summary?.raw_current_order_total?.value
  const cancelledAt = order.canceled_at ?? order.updated_at ?? order.created_at

  return (
    <Base preview={preview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Uw bestelling is geannuleerd
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          Ordernummer #{order.display_id} | {formatDateNL(cancelledAt)}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          Beste {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          We bevestigen dat uw bestelling #{order.display_id} is geannuleerd.
          Het volledige bedrag wordt teruggestort naar de oorspronkelijke
          betaalmethode.
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Geannuleerde artikelen
        </Text>
        {order.items?.map((item) => (
          <Row key={item.id} className="mb-[8px]">
            <Column className="text-black text-[13px] leading-[20px]" align="left">
              {item.product_title}
              {item.variant_title ? (
                <span className="text-[#666666]"> | {item.variant_title}</span>
              ) : null}
              <span className="text-[#666666]"> × {item.quantity}</span>
            </Column>
            <Column
              className="text-black text-[13px] leading-[20px] whitespace-nowrap"
              align="right"
              width="90"
            >
              {formatMoney((item as any).unit_price * item.quantity, currency)}
            </Column>
          </Row>
        ))}
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[16px] mx-0 w-full" />

      <Section>
        <Row>
          <Column className="text-black text-[14px] font-semibold" align="left">
            Terug te storten bedrag
          </Column>
          <Column
            className="text-black text-[14px] font-semibold whitespace-nowrap"
            align="right"
            width="90"
          >
            {formatMoney(refundTotal, currency)}
          </Column>
        </Row>
        <Text className="text-[#666666] text-[11px] leading-[16px] mt-[4px] mb-0">
          Inclusief btw en verzendkosten.
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Wanneer ontvangt u uw geld terug?
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          De terugstorting wordt direct in gang gezet. Afhankelijk van uw bank
          of kaartuitgever kan het 5 tot 10 werkdagen duren voordat het bedrag
          op uw rekening zichtbaar is.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] mt-[12px]">
          U ontvangt een aparte bevestiging zodra de terugstorting is verwerkt.
          Als u na 10 werkdagen niets heeft ontvangen, neem dan contact met ons
          op zodat we het samen kunnen nakijken.
        </Text>
      </Section>
    </Base>
  )
}

OrderCancelledTemplate.PreviewProps = {
  order: {
    id: 'test-order-id',
    display_id: 'ORD-123',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    canceled_at: new Date().toISOString(),
    email: 'test@example.com',
    currency_code: 'EUR',
    items: [
      {
        id: 'item-1',
        title: 'BPC-157 10mg',
        product_title: 'BPC-157',
        variant_title: '10mg flacon',
        quantity: 2,
        unit_price: 45,
      },
    ],
    shipping_address: {
      first_name: 'Jan',
      last_name: 'de Vries',
      address_1: 'Voorbeeldstraat 12',
      city: 'Amsterdam',
      province: '',
      postal_code: '1011 AB',
      country_code: 'NL',
    },
    summary: { raw_current_order_total: { value: 90 } },
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
  },
} as OrderCancelledPreviewProps

export default OrderCancelledTemplate
