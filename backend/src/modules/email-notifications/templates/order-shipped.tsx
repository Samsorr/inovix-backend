import { Text, Section, Hr, Row, Column, Link } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'
import { OrderDTO, OrderAddressDTO } from '@medusajs/framework/types'

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
  preview?: string
}

export const isOrderShippedTemplateData = (
  data: any
): data is OrderShippedTemplateProps =>
  typeof data.order === 'object' &&
  typeof data.shippingAddress === 'object' &&
  Array.isArray(data.labels) &&
  Array.isArray(data.items)

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

export const OrderShippedTemplate: React.FC<OrderShippedTemplateProps> & {
  PreviewProps: OrderShippedTemplateProps
} = ({
  order,
  shippingAddress,
  labels,
  items,
  shippedAt,
  preview = 'Uw bestelling is onderweg',
}) => {
  const trackedLabels = labels.filter(
    (l) => l.tracking_number || l.tracking_url
  )

  return (
    <Base preview={preview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Uw bestelling is onderweg
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          Ordernummer #{order.display_id}
          {shippedAt ? ` | verzonden ${formatDateNL(shippedAt)}` : ''}
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          Beste {shippingAddress.first_name} {shippingAddress.last_name},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          Uw pakket is zojuist overgedragen aan de vervoerder. Hieronder vindt u
          de trackinggegevens en de inhoud van deze zending.
        </Text>
      </Section>

      {trackedLabels.length > 0 ? (
        <>
          <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />
          <Section>
            <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
              Track en trace
            </Text>
            {trackedLabels.map((label, idx) => (
              <Section key={idx} className="mb-[8px]">
                {label.tracking_number ? (
                  <Text className="text-black text-[13px] leading-[20px] m-0">
                    Trackingnummer:{' '}
                    <span className="font-semibold">
                      {label.tracking_number}
                    </span>
                  </Text>
                ) : null}
                {label.tracking_url ? (
                  <Text className="text-[13px] leading-[20px] m-0">
                    <Link
                      href={label.tracking_url}
                      className="text-black underline"
                    >
                      Volg uw zending
                    </Link>
                  </Text>
                ) : null}
              </Section>
            ))}
          </Section>
        </>
      ) : null}

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Inhoud van deze zending
        </Text>
        {items.map((item) => (
          <Row key={item.id} className="mb-[8px]">
            <Column
              className="text-black text-[13px] leading-[20px]"
              align="left"
            >
              {item.title ?? 'Artikel'}
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
          Verzendadres
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
      tracking_number: '3SABCD1234567',
      tracking_url: 'https://postnl.nl/track?code=3SABCD1234567',
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
