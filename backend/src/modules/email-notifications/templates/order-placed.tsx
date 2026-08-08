import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderDTO, OrderAddressDTO } from '@medusajs/framework/types'
import type { EmailLocale } from '../../../lib/email-locale'
import {
  formatEmailDate,
  formatEmailMoney,
  toEmailNumber,
  ORDER_PLACED_I18N,
} from './email-i18n'

export const ORDER_PLACED = 'order-placed'

interface OrderPlacedPreviewProps {
  order: OrderDTO & {
    display_id: string
    summary: { raw_current_order_total: { value: number } }
  }
  shippingAddress: OrderAddressDTO
}

export interface OrderPlacedTemplateProps {
  order: OrderDTO & {
    display_id: string
    // Optional on purpose: `summary` is a relation and production genuinely
    // serves orders without it (payment.captured arriving before the summary
    // row is committed, manually created admin orders). It used to be typed as
    // required, which is why line 95 dereferenced it unguarded and threw
    // inside renderAsync, killing the whole email.
    summary?: { raw_current_order_total?: { value?: number | string } } | null
  }
  shippingAddress: OrderAddressDTO
  locale?: EmailLocale
  preview?: string
}

// `typeof null === 'object'`, so the old guard happily accepted
// `{ order: null }` and let the template blow up on the first property access.
export const isOrderPlacedTemplateData = (data: any): data is OrderPlacedTemplateProps =>
  data != null &&
  typeof data === 'object' &&
  data.order != null &&
  typeof data.order === 'object' &&
  data.shippingAddress != null &&
  typeof data.shippingAddress === 'object'

export const OrderPlacedTemplate: React.FC<OrderPlacedTemplateProps> & {
  PreviewProps: OrderPlacedPreviewProps
} = ({ order, shippingAddress, locale = 'nl', preview }) => {
  const t = ORDER_PLACED_I18N[locale] ?? ORDER_PLACED_I18N.nl
  const currency = order.currency_code
  const totalValue = order.summary?.raw_current_order_total?.value

  return (
    <Base preview={preview ?? t.preview} locale={locale}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {t.heading}
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          {t.orderNumber} #{order.display_id} | {formatEmailDate(order.created_at, locale)}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          {t.greeting} {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          {t.body}
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          {t.yourOrder}
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
              {/* toEmailNumber(): query.graph serves money/quantity as raw
                  BigNumber objects on some paths, and Number() on those is NaN,
                  which rendered "€ NaN" at the customer. */}
              {formatEmailMoney(
                toEmailNumber((item as any).unit_price) * toEmailNumber(item.quantity),
                currency,
                locale
              )}
            </Column>
          </Row>
        ))}
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[16px] mx-0 w-full" />

      {/* Optional chaining is load-bearing: an order without a committed
          `summary` relation used to throw here, inside renderAsync, which
          killed the confirmation and surfaced as "undefined - unknown error".
          When the total is genuinely unknown the row is dropped rather than
          printing a wrong or empty amount. */}
      {totalValue != null ? (
        <Section>
          <Row>
            <Column className="text-black text-[14px] font-semibold" align="left">
              {t.total}
            </Column>
            <Column
              className="text-black text-[14px] font-semibold whitespace-nowrap"
              align="right"
              width="90"
            >
              {formatEmailMoney(totalValue, currency, locale)}
            </Column>
          </Row>
          <Text className="text-[#666666] text-[11px] leading-[16px] mt-[4px] mb-0">
            {t.inclVat}
          </Text>
        </Section>
      ) : null}

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          {t.shippingAddress}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          {shippingAddress.first_name} {shippingAddress.last_name}
        </Text>
        {shippingAddress.company ? (
          <Text className="text-black text-[13px] leading-[20px] m-0">
            {shippingAddress.company}
          </Text>
        ) : null}
        <Text className="text-black text-[13px] leading-[20px] m-0">
          {shippingAddress.address_1}
          {shippingAddress.address_2 ? `, ${shippingAddress.address_2}` : ''}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          {shippingAddress.postal_code} {shippingAddress.city}
          {shippingAddress.province ? `, ${shippingAddress.province}` : ''}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0 uppercase">
          {shippingAddress.country_code}
        </Text>
      </Section>
    </Base>
  )
}

OrderPlacedTemplate.PreviewProps = {
  order: {
    id: 'test-order-id',
    display_id: 'ORD-123',
    created_at: new Date().toISOString(),
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
      {
        id: 'item-2',
        title: 'TB-500 5mg',
        product_title: 'TB-500',
        variant_title: '5mg flacon',
        quantity: 1,
        unit_price: 60,
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
    summary: { raw_current_order_total: { value: 150 } },
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
} as OrderPlacedPreviewProps

export default OrderPlacedTemplate
