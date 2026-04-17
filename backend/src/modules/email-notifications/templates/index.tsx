import { ReactNode } from 'react'
import { MedusaError } from '@medusajs/framework/utils'
import { InviteUserEmail, INVITE_USER, isInviteUserData } from './invite-user'
import { OrderPlacedTemplate, ORDER_PLACED, isOrderPlacedTemplateData } from './order-placed'
import { OrderShippedTemplate, ORDER_SHIPPED, isOrderShippedTemplateData } from './order-shipped'
import { PasswordResetEmail, PASSWORD_RESET, isPasswordResetData } from './password-reset'
import {
  PasswordChangedEmail,
  PASSWORD_CHANGED,
  isPasswordChangedData,
} from './password-changed'
import {
  AbandonedCartPaidTemplate,
  ABANDONED_CART_PAID,
  isAbandonedCartPaidData,
} from './abandoned-cart-paid'
import {
  OrderCancelledTemplate,
  ORDER_CANCELLED,
  isOrderCancelledTemplateData,
} from './order-cancelled'
import {
  PaymentFailedTemplate,
  PAYMENT_FAILED,
  isPaymentFailedData,
} from './payment-failed'
import {
  OrderRefundedTemplate,
  ORDER_REFUNDED,
  isOrderRefundedTemplateData,
} from './order-refunded'
import {
  CustomerWelcomeTemplate,
  CUSTOMER_WELCOME,
  isCustomerWelcomeData,
} from './customer-welcome'

export const EmailTemplates = {
  INVITE_USER,
  ORDER_PLACED,
  ORDER_SHIPPED,
  ORDER_CANCELLED,
  ORDER_REFUNDED,
  PASSWORD_RESET,
  PASSWORD_CHANGED,
  ABANDONED_CART_PAID,
  PAYMENT_FAILED,
  CUSTOMER_WELCOME,
} as const

export type EmailTemplateType = keyof typeof EmailTemplates

export function generateEmailTemplate(templateKey: string, data: unknown): ReactNode {
  switch (templateKey) {
    case EmailTemplates.INVITE_USER:
      if (!isInviteUserData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.INVITE_USER}"`
        )
      }
      return <InviteUserEmail {...data} />

    case EmailTemplates.ORDER_PLACED:
      if (!isOrderPlacedTemplateData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ORDER_PLACED}"`
        )
      }
      return <OrderPlacedTemplate {...data} />

    case EmailTemplates.ORDER_SHIPPED:
      if (!isOrderShippedTemplateData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ORDER_SHIPPED}"`
        )
      }
      return <OrderShippedTemplate {...data} />

    case EmailTemplates.ORDER_CANCELLED:
      if (!isOrderCancelledTemplateData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ORDER_CANCELLED}"`
        )
      }
      return <OrderCancelledTemplate {...data} />

    case EmailTemplates.PASSWORD_RESET:
      if (!isPasswordResetData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.PASSWORD_RESET}"`
        )
      }
      return <PasswordResetEmail {...data} />

    case EmailTemplates.PASSWORD_CHANGED:
      if (!isPasswordChangedData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.PASSWORD_CHANGED}"`
        )
      }
      return <PasswordChangedEmail {...data} />

    case EmailTemplates.ABANDONED_CART_PAID:
      if (!isAbandonedCartPaidData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ABANDONED_CART_PAID}"`
        )
      }
      return <AbandonedCartPaidTemplate {...data} />

    case EmailTemplates.PAYMENT_FAILED:
      if (!isPaymentFailedData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.PAYMENT_FAILED}"`
        )
      }
      return <PaymentFailedTemplate {...data} />

    case EmailTemplates.ORDER_REFUNDED:
      if (!isOrderRefundedTemplateData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ORDER_REFUNDED}"`
        )
      }
      return <OrderRefundedTemplate {...data} />

    case EmailTemplates.CUSTOMER_WELCOME:
      if (!isCustomerWelcomeData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.CUSTOMER_WELCOME}"`
        )
      }
      return <CustomerWelcomeTemplate {...data} />

    default:
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown template key: "${templateKey}"`
      )
  }
}

export {
  InviteUserEmail,
  OrderPlacedTemplate,
  OrderShippedTemplate,
  OrderCancelledTemplate,
  OrderRefundedTemplate,
  PasswordResetEmail,
  PasswordChangedEmail,
  AbandonedCartPaidTemplate,
  PaymentFailedTemplate,
  CustomerWelcomeTemplate,
}
