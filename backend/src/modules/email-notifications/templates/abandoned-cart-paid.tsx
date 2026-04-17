import { Text, Section, Hr, Row, Column } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'

export const ABANDONED_CART_PAID = 'abandoned-cart-paid'

export interface AbandonedCartPaidProps {
  transactionId: string
  orderCode: string | number
  amountFormatted: string
  currency: string
  customerEmail?: string | null
  cartId?: string | null
  cartEmail?: string | null
  paymentMethod?: string | null
  detectedAt: string
  preview?: string
}

export const isAbandonedCartPaidData = (data: any): data is AbandonedCartPaidProps =>
  typeof data?.transactionId === 'string' &&
  (typeof data?.orderCode === 'string' || typeof data?.orderCode === 'number') &&
  typeof data?.amountFormatted === 'string'

export const AbandonedCartPaidTemplate: React.FC<AbandonedCartPaidProps> & {
  PreviewProps: AbandonedCartPaidProps
} = ({
  transactionId,
  orderCode,
  amountFormatted,
  currency,
  customerEmail,
  cartId,
  cartEmail,
  paymentMethod,
  detectedAt,
  preview = 'Betaling ontvangen maar geen order in Medusa',
}) => {
  const email = customerEmail || cartEmail

  return (
    <Base preview={preview} showCustomerFooter={false}>
      <Section className="mt-[24px]">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Abandoned cart, paid
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          Customer paid via Viva but no Medusa order was created.
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Viva transaction
        </Text>
        <Row className="mb-[4px]">
          <Column className="text-[#666666] text-[12px]" align="left" width="120">Transaction ID</Column>
          <Column className="text-black text-[12px] font-mono break-all" align="left">{transactionId}</Column>
        </Row>
        <Row className="mb-[4px]">
          <Column className="text-[#666666] text-[12px]" align="left" width="120">Order code</Column>
          <Column className="text-black text-[12px] font-mono" align="left">{String(orderCode)}</Column>
        </Row>
        <Row className="mb-[4px]">
          <Column className="text-[#666666] text-[12px]" align="left" width="120">Amount</Column>
          <Column className="text-black text-[12px] font-semibold" align="left">{amountFormatted} {currency.toUpperCase()}</Column>
        </Row>
        {paymentMethod ? (
          <Row className="mb-[4px]">
            <Column className="text-[#666666] text-[12px]" align="left" width="120">Payment method</Column>
            <Column className="text-black text-[12px]" align="left">{paymentMethod}</Column>
          </Row>
        ) : null}
        <Row className="mb-[4px]">
          <Column className="text-[#666666] text-[12px]" align="left" width="120">Detected at</Column>
          <Column className="text-black text-[12px]" align="left">{detectedAt}</Column>
        </Row>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Customer
        </Text>
        <Row className="mb-[4px]">
          <Column className="text-[#666666] text-[12px]" align="left" width="120">Email</Column>
          <Column className="text-black text-[12px] break-all" align="left">{email ?? 'unknown'}</Column>
        </Row>
        {cartId ? (
          <Row className="mb-[4px]">
            <Column className="text-[#666666] text-[12px]" align="left" width="120">Cart ID</Column>
            <Column className="text-black text-[12px] font-mono break-all" align="left">{cartId}</Column>
          </Row>
        ) : null}
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Actie
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          1. Verifieer de betaling in het Viva dashboard.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          2. Neem contact op met de klant via het bovenstaande email adres.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          3. Maak de order handmatig aan in Medusa admin, of refund via Viva.
        </Text>
      </Section>
    </Base>
  )
}

AbandonedCartPaidTemplate.PreviewProps = {
  transactionId: '12345678-1234-1234-1234-123456789abc',
  orderCode: 987654321,
  amountFormatted: '150,00',
  currency: 'EUR',
  customerEmail: 'klant@voorbeeld.nl',
  cartEmail: 'klant@voorbeeld.nl',
  cartId: 'cart_01HXYZ...',
  paymentMethod: 'Card',
  detectedAt: new Date().toISOString(),
} as AbandonedCartPaidProps

export default AbandonedCartPaidTemplate
