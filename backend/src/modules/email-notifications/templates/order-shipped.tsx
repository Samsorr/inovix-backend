import { Text, Section, Hr, Row, Column, Link, Button } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderDTO, OrderAddressDTO } from '@medusajs/framework/types'
import type { EmailLocale } from '../../../lib/email-locale'
import { formatEmailDate, ORDER_SHIPPED_I18N } from './email-i18n'
import { resolveText } from './overrides'

export const ORDER_SHIPPED = 'order-shipped'

interface ShipmentLabel {
  tracking_number?: string | null
  tracking_url?: string | null
  label_url?: string | null
}

interface ShipmentItem {
  id: string
  title?: string | null
  quantity: number
}

export interface OrderShippedTemplateProps {
  order: OrderDTO & {
    display_id: string
  }
  shippingAddress: OrderAddressDTO
  labels: ShipmentLabel[]
  items: ShipmentItem[]
  shippedAt?: string | Date | null
  locale?: EmailLocale
  preview?: string
  /**
   * Operator-edited copy, keyed by the i18n key it replaces. Only the fields
   * in `editable-fields.ts` are ever present. Absent on every automatic send,
   * which then renders exactly as it always did.
   */
  overrides?: Record<string, string>
}

export const isOrderShippedTemplateData = (
  data: any
): data is OrderShippedTemplateProps =>
  // `typeof null === 'object'`, so null must be excluded explicitly or the
  // template throws on the first property access, inside renderAsync.
  data != null &&
  typeof data === 'object' &&
  data.order != null &&
  typeof data.order === 'object' &&
  data.shippingAddress != null &&
  typeof data.shippingAddress === 'object' &&
  Array.isArray(data.labels) &&
  Array.isArray(data.items)

export const OrderShippedTemplate: React.FC<OrderShippedTemplateProps> & {
  PreviewProps: OrderShippedTemplateProps
} = ({
  order,
  shippingAddress,
  labels,
  items,
  shippedAt,
  locale = 'nl',
  preview,
  overrides,
}) => {
  const t = ORDER_SHIPPED_I18N[locale] ?? ORDER_SHIPPED_I18N.nl
  const trackedLabels = labels.filter(
    (l) => l.tracking_number || l.tracking_url
  )

  // The override replaces ONE label's URL: the same one the composer offered as
  // the default, which is the first label that actually carries a URL (see
  // `firstTrackingUrl` in editable-fields.ts). Picking trackedLabels[0] instead
  // would target a different parcel whenever the first label has a tracking
  // number but no URL, so the operator would edit one link and change another.
  // When no label has a URL the operator is supplying the only one, so it goes
  // on the first tracked label.
  // Must stay identical to `primaryTrackingLabel` in editable-fields.ts, or the
  // composer offers one parcel's defaults while this rewrites another's.
  const urlIdx = trackedLabels.findIndex((l) => l.tracking_url)
  const overrideIdx = urlIdx === -1 ? 0 : urlIdx
  const trackingUrlFor = (label: ShipmentLabel, idx: number): string =>
    idx === overrideIdx
      ? resolveText(overrides, 'trackingUrl', label.tracking_url ?? '')
      : label.tracking_url ?? ''
  const trackingCodeFor = (label: ShipmentLabel, idx: number): string =>
    idx === overrideIdx
      ? resolveText(overrides, 'trackingCode', label.tracking_number ?? '')
      : label.tracking_number ?? ''

  return (
    <Base preview={preview ?? t.preview} locale={locale}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {resolveText(overrides, 'heading', t.heading)}
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          {t.orderNumber} #{order.display_id}
          {shippedAt ? ` | ${t.shippedOn} ${formatEmailDate(shippedAt, locale)}` : ''}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          {t.greeting} {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          {resolveText(overrides, 'body', t.body)}
        </Text>
      </Section>

      {trackedLabels.length > 0 ? (
        <>
          <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />
          <Section>
            <Text className="text-black text-[15px] font-semibold leading-[24px] m-0 mb-[4px]">
              {resolveText(overrides, 'trackingHeading', t.trackingHeading)}
            </Text>
            <Text className="text-[#666666] text-[13px] leading-[20px] m-0 mb-[16px]">
              {resolveText(overrides, 'trackingBody', t.trackingBody)}
            </Text>
            {trackedLabels.map((label, idx) => {
              const trackingUrl = trackingUrlFor(label, idx)
              const trackingCode = trackingCodeFor(label, idx)
              return (
                <Section key={idx} className="mb-[16px]">
                  {trackingCode ? (
                    <Text className="text-black text-[13px] leading-[20px] m-0 mb-[12px]">
                      {t.trackingNumber}{' '}
                      <span className="font-semibold">
                        {trackingCode}
                      </span>
                    </Text>
                  ) : null}
                  {trackingUrl ? (
                    <Button
                      href={trackingUrl}
                      style={{
                        backgroundColor: '#000000',
                        color: '#ffffff',
                        padding: '12px 24px',
                        fontSize: '14px',
                        fontWeight: '600',
                        lineHeight: '20px',
                        textDecoration: 'none',
                        display: 'inline-block',
                        borderRadius: '0px',
                      }}
                    >
                      {resolveText(overrides, 'trackButton', t.trackButton)}
                    </Button>
                  ) : null}
                </Section>
              )
            })}
          </Section>
        </>
      ) : null}

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          {t.contents}
        </Text>
        {items.map((item) => (
          <Row key={item.id} className="mb-[8px]">
            <Column
              className="text-black text-[13px] leading-[20px]"
              align="left"
            >
              {item.title ?? t.itemFallback}
            </Column>
            <Column
              className="text-black text-[13px] leading-[20px] whitespace-nowrap"
              align="right"
              width="60"
            >
              × {item.quantity}
            </Column>
          </Row>
        ))}
      </Section>

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

OrderShippedTemplate.PreviewProps = {
  order: {
    id: 'test-order-id',
    display_id: 'ORD-123',
    email: 'test@example.com',
    currency_code: 'EUR',
  } as OrderShippedTemplateProps['order'],
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
  labels: [
    {
      tracking_number: 'JVGL01234567890',
      tracking_url: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1011AB?lang=nl_NL',
      label_url: null,
    },
  ],
  items: [
    { id: 'item-1', title: 'BPC-157 10mg flacon', quantity: 2 },
    { id: 'item-2', title: 'TB-500 5mg flacon', quantity: 1 },
  ],
  shippedAt: new Date().toISOString(),
}

export default OrderShippedTemplate
