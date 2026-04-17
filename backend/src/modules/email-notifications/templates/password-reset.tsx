import { Button, Link, Section, Text } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'

export const PASSWORD_RESET = 'password-reset'

export interface PasswordResetEmailProps {
  resetLink: string
  actorType: 'customer' | 'user'
  preview?: string
}

export const isPasswordResetData = (data: any): data is PasswordResetEmailProps =>
  typeof data?.resetLink === 'string' &&
  (data?.actorType === 'customer' || data?.actorType === 'user') &&
  (typeof data?.preview === 'string' || !data?.preview)

const copy = {
  customer: {
    heading: 'Wachtwoord herstellen',
    intro:
      'Er is een verzoek ingediend om het wachtwoord van uw Inovix-account te herstellen.',
    instruction:
      'Klik op de onderstaande knop om een nieuw wachtwoord in te stellen. Deze link verloopt over 15 minuten.',
    button: 'Nieuw wachtwoord instellen',
    fallback: 'Of kopieer en plak deze URL in uw browser:',
    ignore:
      'Heeft u geen wachtwoordherstel aangevraagd? Dan kunt u deze e-mail negeren, uw wachtwoord blijft ongewijzigd.',
    defaultPreview: 'Herstel uw Inovix-wachtwoord',
  },
  user: {
    heading: 'Reset your password',
    intro: 'A request was made to reset the password on your Inovix admin account.',
    instruction:
      'Click the button below to set a new password. This link expires in 15 minutes.',
    button: 'Set new password',
    fallback: 'Or copy and paste this URL into your browser:',
    ignore:
      "Didn't request a password reset? You can ignore this email, your password will remain unchanged.",
    defaultPreview: 'Reset your Inovix admin password',
  },
} as const

export const PasswordResetEmail: React.FC<PasswordResetEmailProps> & {
  PreviewProps: PasswordResetEmailProps
} = ({ resetLink, actorType, preview }) => {
  const t = copy[actorType]
  return (
    <Base preview={preview ?? t.defaultPreview}>
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {t.heading}
        </Text>
      </Section>
      <Section>
        <Text className="text-black text-[14px] leading-[24px]">{t.intro}</Text>
        <Text className="text-black text-[14px] leading-[24px]">
          {t.instruction}
        </Text>
      </Section>
      <Section className="text-center mt-4 mb-[32px]">
        <Button
          className="bg-[#000000] rounded text-white text-[12px] font-semibold no-underline px-5 py-3"
          href={resetLink}
        >
          {t.button}
        </Button>
      </Section>
      <Section>
        <Text className="text-black text-[14px] leading-[24px]">{t.fallback}</Text>
        <Text
          style={{
            maxWidth: '100%',
            wordBreak: 'break-all',
            overflowWrap: 'break-word',
          }}
        >
          <Link href={resetLink} className="text-blue-600 no-underline">
            {resetLink}
          </Link>
        </Text>
      </Section>
      <Section>
        <Text className="text-[#666666] text-[12px] leading-[20px]">{t.ignore}</Text>
      </Section>
    </Base>
  )
}

PasswordResetEmail.PreviewProps = {
  resetLink:
    'https://inovix.example/account/wachtwoord-herstellen?token=abc123xyzxyzxyzxyzxyzxyzxyzxyz&email=klant@voorbeeld.nl',
  actorType: 'customer',
} as PasswordResetEmailProps

export default PasswordResetEmail
