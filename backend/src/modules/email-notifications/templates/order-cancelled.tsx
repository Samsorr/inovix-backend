import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderDTO, OrderAddressDTO } from '@medusajs/framework/types'
import type { EmailLocale } from '../../../lib/email-locale'
import {
  formatEmailDate,
  formatEmailMoney,
  toEmailNumber,
  ORDER_CANCELLED_I18N,
  type OrderCancelledRefundState,
} from './email-i18n'

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
    summary?: { raw_current_order_total?: { value?: number } } | null
  }
  shippingAddress: OrderAddressDTO
  locale?: EmailLocale
  preview?: string
  /**
   * What actually happened to the money. Defaults to `refund_pending` so a
   * replay of a pre-existing notification row (which has no refundState in its
   * stored data) reproduces the email that was originally sent.
   */
  refundState?: OrderCancelledRefundState
  /** The amount to show. Falls back to the order total. */
  refundAmount?: number | string | null
}

export const isOrderCancelledTemplateData = (
  data: any
): data is OrderCancelledTemplateProps =>
  data != null &&
  typeof data === 'object' &&
  data.order != null &&
  typeof data.order === 'object' &&
  data.shippingAddress != null &&
  typeof data.shippingAddress === 'object'

export const OrderCancelledTemplate: React.FC<OrderCancelledTemplateProps> & {
  PreviewProps: OrderCancelledPreviewProps
} = ({
  order,
  shippingAddress,
  locale = 'nl',
  preview,
  refundState = 'refund_pending',
  refundAmount,
}) => {
  const base = ORDER_CANCELLED_I18N[locale] ?? ORDER_CANCELLED_I18N.nl
  const t = base[refundState] ?? base.refund_pending
  const currency = order.currency_code
  const refundTotal =
    refundAmount ?? order.summary?.raw_current_order_total?.value
  const cancelledAt = order.canceled_at ?? order.updated_at ?? order.created_at

  return (
    <Base preview={preview ?? base.preview} locale={locale}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {base.heading}
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          {base.orderNumber} #{order.display_id} | {formatEmailDate(cancelledAt, locale)}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          {base.greeting} {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          {t.body(order.display_id)}
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          {base.cancelledItems}
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

      <Section>
        <Row>
          <Column className="text-black text-[14px] font-semibold" align="left">
            {t.amountLabel}
          </Column>
          <Column
            className="text-black text-[14px] font-semibold whitespace-nowrap"
            align="right"
            width="90"
          >
            {formatEmailMoney(refundTotal, currency, locale)}
          </Column>
        </Row>
        <Text className="text-[#666666] text-[11px] leading-[16px] mt-[4px] mb-0">
          {base.inclVat}
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          {t.whenHeading}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          {t.whenBody1}
        </Text>
        <Text className="text-black text-[13px] leading-[20px] mt-[12px]">
          {t.whenBody2}
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
