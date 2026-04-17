import { Section, Text } from '@react-email/components'
import * as React from 'react'
import { Base } from './base'

export const PASSWORD_CHANGED = 'password-changed'

export interface PasswordChangedEmailProps {
  actorType: 'customer' | 'user'
  changedAt: string
  supportEmail?: string
  preview?: string
}

export const isPasswordChangedData = (data: any): data is PasswordChangedEmailProps =>
  (data?.actorType === 'customer' || data?.actorType === 'user') &&
  typeof data?.changedAt === 'string' &&
  (typeof data?.supportEmail === 'string' || !data?.supportEmail) &&
  (typeof data?.preview === 'string' || !data?.preview)

const copy = {
  customer: {
    heading: 'Wachtwoord gewijzigd',
    intro: (when: string) =>
      `Uw Inovix-wachtwoord is zojuist gewijzigd op ${when}.`,
    warning: (support?: string) =>
      `Was u dit niet? Neem direct contact met ons op${
        support ? ` via ${support}` : ''
      } en wijzig uw wachtwoord zo snel mogelijk.`,
    defaultPreview: 'Uw Inovix-wachtwoord is gewijzigd',
  },
  user: {
    heading: 'Password changed',
    intro: (when: string) =>
      `Your Inovix admin password was just changed at ${when}.`,
    warning: (support?: string) =>
      `Was this not you? Contact us immediately${
        support ? ` at ${support}` : ''
      } and change your password right away.`,
    defaultPreview: 'Your Inovix admin password was changed',
  },
} as const

export const PasswordChangedEmail: React.FC<PasswordChangedEmailProps> & {
  PreviewProps: PasswordChangedEmailProps
} = ({ actorType, changedAt, supportEmail, preview }) => {
  const t = copy[actorType]
  const showCustomerFooter = actorType === 'customer'
  return (
    <Base
      preview={preview ?? t.defaultPreview}
      showCustomerFooter={showCustomerFooter}
    >
      <Section className="mt-[24px] text-center">
        <Text className="text-black text-[18px] font-semibold leading-[28px] m-0">
          {t.heading}
        </Text>
      </Section>
      <Section>
        <Text className="text-black text-[14px] leading-[24px]">
          {t.intro(changedAt)}
        </Text>
        <Text className="text-black text-[14px] leading-[24px]">
          {t.warning(supportEmail)}
        </Text>
      </Section>
    </Base>
  )
}

PasswordChangedEmail.PreviewProps = {
  actorType: 'customer',
  changedAt: '17 april 2026 om 14:32',
  supportEmail: 'support@inovix-peptides.com',
} as PasswordChangedEmailProps

export default PasswordChangedEmail
