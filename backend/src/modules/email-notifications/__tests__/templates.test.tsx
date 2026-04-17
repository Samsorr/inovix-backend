/* eslint-disable @typescript-eslint/no-var-requires */
// Make React globally available before any source modules load.
// Source TSX files like index.tsx use JSX without importing React,
// which requires React in scope when SWC uses the classic JSX transform.
const React = require('react')
;(globalThis as any).React = React

jest.mock('@react-email/components', () => ({
  Button: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  Section: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <p>{children}</p>,
  Img: (props: any) => <img {...props} />,
  Hr: () => <hr />,
  Html: ({ children }: any) => <>{children}</>,
  Body: ({ children }: any) => <>{children}</>,
  Container: ({ children }: any) => <div>{children}</div>,
  Preview: ({ children }: any) => <>{children}</>,
  Tailwind: ({ children }: any) => <>{children}</>,
  Head: () => null,
  Row: ({ children }: any) => <div>{children}</div>,
  Column: ({ children }: any) => <span>{children}</span>,
}), { virtual: true })

jest.mock('@medusajs/framework/utils', () => ({
  MedusaError: class MedusaError extends Error {
    static Types = { INVALID_DATA: 'invalid_data', UNEXPECTED_STATE: 'unexpected_state' }
    type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  },
}))

import { generateEmailTemplate } from '../templates'
import { isInviteUserData } from '../templates/invite-user'
import { isOrderPlacedTemplateData } from '../templates/order-placed'

describe('generateEmailTemplate', () => {
  describe('invite-user template', () => {
    it('returns a ReactNode for valid invite-user data', () => {
      const result = generateEmailTemplate('invite-user', {
        inviteLink: 'https://example.com/invite?token=abc123',
      })

      expect(result).toBeDefined()
      expect(result).not.toBeNull()
    })

    it('throws MedusaError when inviteLink is missing', () => {
      expect(() =>
        generateEmailTemplate('invite-user', { inviteLink: undefined })
      ).toThrow('Invalid data for template "invite-user"')
    })

    it('throws MedusaError when inviteLink is a number instead of a string', () => {
      expect(() =>
        generateEmailTemplate('invite-user', { inviteLink: 12345 })
      ).toThrow('Invalid data for template "invite-user"')
    })
  })

  describe('order-placed template', () => {
    const validOrderData = {
      order: {
        id: 'order_123',
        display_id: 'ORD-001',
        created_at: new Date().toISOString(),
        email: 'buyer@example.com',
        currency_code: 'EUR',
        items: [
          { id: 'item-1', title: 'BPC-157', product_title: 'Peptide BPC-157', quantity: 1, unit_price: 49.99 },
        ],
        shipping_address: { id: 'addr_1' },
        summary: { raw_current_order_total: { value: 49.99 } },
      },
      shippingAddress: {
        first_name: 'John',
        last_name: 'Doe',
        address_1: '123 Lab Street',
        city: 'Amsterdam',
        province: 'NH',
        postal_code: '1012AB',
        country_code: 'NL',
      },
    }

    it('returns a ReactNode for valid order-placed data', () => {
      const result = generateEmailTemplate('order-placed', validOrderData)

      expect(result).toBeDefined()
      expect(result).not.toBeNull()
    })

    it('throws MedusaError when order is missing', () => {
      expect(() =>
        generateEmailTemplate('order-placed', { shippingAddress: {} })
      ).toThrow('Invalid data for template "order-placed"')
    })

    it('throws MedusaError when shippingAddress is missing', () => {
      expect(() =>
        generateEmailTemplate('order-placed', { order: { id: 'o1' } })
      ).toThrow('Invalid data for template "order-placed"')
    })
  })

  describe('unknown template', () => {
    it('throws MedusaError for an unknown template key', () => {
      expect(() =>
        generateEmailTemplate('non-existent-template', {})
      ).toThrow('Unknown template key: "non-existent-template"')
    })
  })
})

describe('isInviteUserData', () => {
  it('returns true for valid data with a string inviteLink', () => {
    expect(isInviteUserData({ inviteLink: 'https://example.com/invite' })).toBe(true)
  })

  it('returns true when inviteLink is a string and preview is a string', () => {
    expect(isInviteUserData({ inviteLink: 'https://example.com', preview: 'Hello' })).toBe(true)
  })

  it('returns false when inviteLink is not a string', () => {
    expect(isInviteUserData({ inviteLink: 123 })).toBe(false)
  })

  it('returns false when inviteLink is undefined', () => {
    expect(isInviteUserData({ inviteLink: undefined })).toBe(false)
  })

  it('returns false when inviteLink is missing entirely', () => {
    expect(isInviteUserData({})).toBe(false)
  })
})

describe('isOrderPlacedTemplateData', () => {
  it('returns true for valid data with order and shippingAddress objects', () => {
    expect(
      isOrderPlacedTemplateData({
        order: { id: 'order_1' },
        shippingAddress: { city: 'Berlin' },
      })
    ).toBe(true)
  })

  it('returns false when order is missing', () => {
    expect(
      isOrderPlacedTemplateData({ shippingAddress: { city: 'Berlin' } })
    ).toBe(false)
  })

  it('returns false when shippingAddress is missing', () => {
    expect(
      isOrderPlacedTemplateData({ order: { id: 'order_1' } })
    ).toBe(false)
  })

  it('returns false when order is a string instead of an object', () => {
    expect(
      isOrderPlacedTemplateData({ order: 'not-an-object', shippingAddress: {} })
    ).toBe(false)
  })

  it('returns true when shippingAddress is null (typeof null is "object")', () => {
    // Note: typeof null === 'object' in JavaScript, so the type guard
    // does not reject null. This is a known quirk of the language.
    expect(
      isOrderPlacedTemplateData({ order: { id: 'order_1' }, shippingAddress: null })
    ).toBe(true)
  })
})
