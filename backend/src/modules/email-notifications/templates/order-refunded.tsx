import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderAddressDTO } from '@medusajs/framework/types'
import type { EmailLocale } from '../../../lib/email-locale'
import { formatEmailDate, formatEmailMoney, ORDER_REFUNDED_I18N } from './email-i18n'

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
  locale?: EmailLocale
  preview?: string
}

export const isOrderRefundedTemplateData = (
  data: any
): data is OrderRefundedTemplateProps =>
  // `typeof null === 'object'`, so null must be excluded explicitly or the
  // template throws on the first property access, inside renderAsync.
  data != null &&
  typeof data === 'object' &&
  data.order != null &&
  typeof data.order === 'object' &&
  data.shippingAddress != null &&
  typeof data.shippingAddress === 'object' &&
  typeof data.refundAmount === 'number'

export const OrderRefundedTemplate: React.FC<OrderRefundedTemplateProps> & {
  PreviewProps: OrderRefundedTemplateProps
} = ({
  order,
  shippingAddress,
  refundAmount,
  refundedAt,
  reason,
  locale = 'nl',
  preview,
}) => {
  const t = ORDER_REFUNDED_I18N[locale] ?? ORDER_REFUNDED_I18N.nl
  const currency = order.currency_code

  return (
    <Base preview={preview ?? t.preview} locale={locale}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {t.heading}
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          {t.orderNumber} #{order.display_id}
          {refundedAt ? ` | ${formatEmailDate(refundedAt, locale)}` : ''}
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
        <Row>
          <Column className="text-black text-[14px] font-semibold" align="left">
            {t.refundedAmount}
          </Column>
          <Column
            className="text-black text-[14px] font-semibold whitespace-nowrap"
            align="right"
            width="90"
          >
            {formatEmailMoney(refundAmount, currency, locale)}
          </Column>
        </Row>
        {reason ? (
          <Text className="text-[#666666] text-[12px] leading-[18px] mt-[8px] mb-0">
            {t.reason} {reason}
          </Text>
        ) : null}
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          {t.methodNote}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] mt-[12px]">
          {t.contactNote}
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
