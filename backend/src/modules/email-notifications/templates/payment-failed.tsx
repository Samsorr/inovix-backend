import { Text, Section, Hr, Button } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'

export const PAYMENT_FAILED = 'payment-failed'

export interface PaymentFailedProps {
  customerName?: string | null
  amountFormatted: string
  currency: string
  retryUrl: string
  preview?: string
}

export const isPaymentFailedData = (data: any): data is PaymentFailedProps =>
  typeof data?.amountFormatted === 'string' &&
  typeof data?.currency === 'string' &&
  typeof data?.retryUrl === 'string'

export const PaymentFailedTemplate: React.FC<PaymentFailedProps> & {
  PreviewProps: PaymentFailedProps
} = ({
  customerName,
  amountFormatted,
  currency,
  retryUrl,
  preview = 'Uw betaling is niet gelukt, probeer opnieuw',
}) => {
  const greetingName = customerName?.trim() || 'daar'

  return (
    <Base preview={preview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Betaling mislukt
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[4px] mb-0">
          Het bedrag is niet afgeschreven van uw rekening.
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          Beste {greetingName},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          Uw betaling van <strong>{amountFormatted} {currency.toUpperCase()}</strong> kon
          niet worden verwerkt. Dit kan verschillende oorzaken hebben, zoals
          onvoldoende saldo, een geblokkeerde kaart of een afgebroken 3D Secure
          verificatie.
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          Uw winkelwagen staat nog voor u klaar. U kunt de betaling opnieuw
          proberen via de knop hieronder.
        </Text>
      </Section>

      <Section className="mt-[24px] text-center">
        <Button
          href={retryUrl}
          className="bg-black text-white text-[14px] font-semibold no-underline rounded px-[20px] py-[12px]"
        >
          Opnieuw proberen
        </Button>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[24px] mx-0 w-full" />

      <Section>
        <Text className="text-[#666666] text-[12px] leading-[20px] m-0">
          Lukt het niet? Reageer op deze e-mail, dan zoeken wij het voor u uit.
        </Text>
      </Section>
    </Base>
  )
}

PaymentFailedTemplate.PreviewProps = {
  customerName: 'Jan de Vries',
  amountFormatted: '150,00',
  currency: 'EUR',
  retryUrl: 'https://inovix-peptides.com/winkelwagen',
} as PaymentFailedProps

export default PaymentFailedTemplate
