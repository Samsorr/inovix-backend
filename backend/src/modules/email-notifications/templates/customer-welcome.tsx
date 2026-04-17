import { Text, Section, Hr, Button } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'

export const CUSTOMER_WELCOME = 'customer-welcome'

export interface CustomerWelcomeTemplateProps {
  firstName?: string | null
  email: string
  storefrontUrl: string
  preview?: string
}

export const isCustomerWelcomeData = (
  data: any
): data is CustomerWelcomeTemplateProps =>
  typeof data.email === 'string' && typeof data.storefrontUrl === 'string'

export const CustomerWelcomeTemplate: React.FC<CustomerWelcomeTemplateProps> & {
  PreviewProps: CustomerWelcomeTemplateProps
} = ({
  firstName,
  email,
  storefrontUrl,
  preview = 'Welkom bij Inovix',
}) => {
  const greetingName = firstName?.trim() || email
  const accountUrl = `${storefrontUrl}/account`
  const productsUrl = `${storefrontUrl}/products`

  return (
    <Base preview={preview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          Welkom bij Inovix
        </Text>
      </Section>

      <Section className="mt-[24px]">
        <Text className="text-black text-[14px] leading-[22px] m-0">
          Beste {greetingName},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[12px]">
          Bedankt voor het aanmaken van uw account bij Inovix. U heeft nu
          toegang tot ons volledige assortiment onderzoekspeptiden, kunt
          eerdere bestellingen inzien en verzendgegevens beheren.
        </Text>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-black text-[13px] font-semibold uppercase tracking-wide m-0 mb-[8px]">
          Hoe te bestellen
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          1. Bekijk ons assortiment en kies de gewenste peptiden.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          2. Voeg producten toe aan uw winkelwagen en ga naar checkout.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] m-0">
          3. Bevestig dat de bestelling uitsluitend voor onderzoek is en
          rond de betaling af.
        </Text>
        <Text className="text-black text-[13px] leading-[20px] mt-[8px]">
          Wij verzenden GMP gecertificeerde, HPLC getoetste peptiden door de
          gehele EU. Standaard met tracking en discrete verpakking.
        </Text>
      </Section>

      <Section className="mt-[24px] text-center">
        <Button
          href={productsUrl}
          className="bg-black text-white rounded text-[13px] font-semibold no-underline px-[20px] py-[12px]"
        >
          Bekijk assortiment
        </Button>
      </Section>

      <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

      <Section>
        <Text className="text-[#666666] text-[12px] leading-[18px] m-0">
          Uw account beheert u via{' '}
          <a href={accountUrl} className="text-[#666666] underline">
            {accountUrl.replace(/^https?:\/\//, '')}
          </a>
          . Hier vindt u uw orderhistorie, adressen en accountgegevens.
        </Text>
      </Section>
    </Base>
  )
}

CustomerWelcomeTemplate.PreviewProps = {
  firstName: 'Jan',
  email: 'jan@example.com',
  storefrontUrl: 'https://inovix-peptides.com',
}

export default CustomerWelcomeTemplate
