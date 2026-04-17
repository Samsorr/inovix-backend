import {
  Html,
  Body,
  Container,
  Preview,
  Tailwind,
  Head,
  Section,
  Text,
  Hr,
  Link,
} from '@react-email/components'
import * as React from 'react'

interface BaseProps {
  preview?: string
  children: React.ReactNode
  /**
   * When true, render the customer-facing footer with the Dutch
   * research-use disclaimer and privacy/terms links. Defaults to true.
   * Set to false for admin emails (invite, admin alerts) where the
   * consumer disclaimer does not apply.
   */
  showCustomerFooter?: boolean
}

const STOREFRONT_URL =
  process.env.STOREFRONT_URL?.replace(/\/$/, '') ?? 'https://inovix-peptides.com'

export const Base: React.FC<BaseProps> = ({
  preview,
  children,
  showCustomerFooter = true,
}) => {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-white my-auto mx-auto font-sans px-2">
          <Container className="border border-solid border-[#eaeaea] rounded my-[40px] mx-auto p-[20px] max-w-[465px] w-full overflow-hidden">
            <div className="max-w-full break-words">{children}</div>

            {showCustomerFooter && (
              <>
                <Hr className="border border-solid border-[#eaeaea] my-[26px] mx-0 w-full" />
                <Section>
                  <Text className="text-[#666666] text-[11px] leading-[18px] m-0">
                    <strong>Uitsluitend voor onderzoeksdoeleinden.</strong>
                    {' '}Producten van Inovix zijn bedoeld voor in-vitro laboratorium
                    onderzoek en niet geschikt voor menselijke of dierlijke consumptie,
                    medische of cosmetische toepassingen.
                  </Text>
                  <Text className="text-[#666666] text-[11px] leading-[18px] mt-[12px]">
                    Vragen? Reageer op deze e-mail of neem contact met ons op via{' '}
                    <Link
                      href={`${STOREFRONT_URL}/contact`}
                      className="text-[#666666] underline"
                    >
                      {STOREFRONT_URL.replace(/^https?:\/\//, '')}/contact
                    </Link>
                    .
                  </Text>
                  <Text className="text-[#999999] text-[10px] leading-[16px] mt-[12px]">
                    Inovix |{' '}
                    <Link
                      href={`${STOREFRONT_URL}/privacy`}
                      className="text-[#999999] underline"
                    >
                      Privacybeleid
                    </Link>
                    {' '}|{' '}
                    <Link
                      href={`${STOREFRONT_URL}/voorwaarden`}
                      className="text-[#999999] underline"
                    >
                      Algemene voorwaarden
                    </Link>
                  </Text>
                </Section>
              </>
            )}
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
