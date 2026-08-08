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

import ReactDOMServer from 'react-dom/server'
import { generateEmailTemplate } from '../templates'
import { isInviteUserData } from '../templates/invite-user'
import { isOrderPlacedTemplateData } from '../templates/order-placed'

// The first render of a react-email tree can suspend once (Tailwind warms an
// internal cache), which under parallel load shows up as "A component
// suspended while responding to synchronous input". Warm it here, the same way
// email-templates-i18n.test.tsx does, so the render assertions below are
// deterministic.
beforeAll(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      ReactDOMServer.renderToStaticMarkup(
        generateEmailTemplate('invite-user', {
          inviteLink: 'https://example.com/invite',
        }) as React.ReactElement
      )
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
})

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

  describe('order-shipped template', () => {
    const validShippedData = {
      order: {
        id: 'order_456',
        display_id: 'ORD-456',
        email: 'buyer@example.com',
        currency_code: 'EUR',
      },
      shippingAddress: {
        first_name: 'Jan',
        last_name: 'de Vries',
        address_1: 'Teststraat 1',
        city: 'Amsterdam',
        province: '',
        postal_code: '1011 AB',
        country_code: 'NL',
      },
      labels: [
        {
          tracking_number: 'JVGL01234567890',
          tracking_url: 'https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1011AB?lang=nl_NL',
          label_url: null,
        },
      ],
      items: [
        { id: 'item-1', title: 'BPC-157 10mg', quantity: 1 },
      ],
      shippedAt: new Date().toISOString(),
    }

    it('renders "Volg uw pakket" button with tracking_url href when label has tracking_url', () => {
      const node = generateEmailTemplate('order-shipped', validShippedData)
      const html = ReactDOMServer.renderToStaticMarkup(node as React.ReactElement)

      expect(html).toContain('Volg uw pakket')
      expect(html).toContain('https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890/1011AB?lang=nl_NL')
    })

    it('still shows tracking number when no tracking_url is present', () => {
      const dataNoUrl = {
        ...validShippedData,
        labels: [{ tracking_number: 'JVGL09999999999', tracking_url: null, label_url: null }],
      }
      const node = generateEmailTemplate('order-shipped', dataNoUrl)
      const html = ReactDOMServer.renderToStaticMarkup(node as React.ReactElement)

      expect(html).toContain('JVGL09999999999')
      expect(html).not.toContain('Volg uw pakket')
    })

    it('throws MedusaError when required fields are missing', () => {
      expect(() =>
        generateEmailTemplate('order-shipped', { order: {}, labels: [] })
      ).toThrow('Invalid data for template "order-shipped"')
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

  // `typeof null === 'object'`, so the old guard let null through and the
  // template threw on the first property access, inside renderAsync. The
  // failure surfaced as "undefined - unknown error" with the real stack gone.
  it('returns false when shippingAddress is null', () => {
    expect(
      isOrderPlacedTemplateData({ order: { id: 'order_1' }, shippingAddress: null })
    ).toBe(false)
  })

  it('returns false when order is null', () => {
    expect(
      isOrderPlacedTemplateData({ order: null, shippingAddress: { city: 'Berlin' } })
    ).toBe(false)
  })

  it('returns false when the whole payload is null', () => {
    expect(isOrderPlacedTemplateData(null)).toBe(false)
    expect(isOrderPlacedTemplateData(undefined)).toBe(false)
  })
})

describe('order-placed with the data shapes production actually produces', () => {
  const shippingAddress = {
    first_name: 'Jan',
    last_name: 'de Vries',
    address_1: 'Voorbeeldstraat 12',
    city: 'Amsterdam',
    postal_code: '1011 AB',
    country_code: 'NL',
  }

  function baseOrder(extra: Record<string, unknown> = {}) {
    return {
      id: 'order_1',
      display_id: 'ORD-001',
      created_at: new Date().toISOString(),
      email: 'buyer@example.com',
      currency_code: 'EUR',
      items: [
        {
          id: 'item-1',
          product_title: 'BPC-157',
          variant_title: '10mg',
          quantity: 2,
          unit_price: 45,
        },
      ],
      ...extra,
    }
  }

  function renderOrderPlaced(order: Record<string, unknown>): string {
    const node = generateEmailTemplate('order-placed', { order, shippingAddress })
    return ReactDOMServer.renderToStaticMarkup(node as React.ReactElement)
  }

  // Reproduced by the auditor: `order.summary.raw_current_order_total.value`
  // with no optional chaining threw a TypeError inside renderAsync, which
  // killed the whole confirmation email.
  it('renders an order with no summary relation instead of throwing', () => {
    const html = renderOrderPlaced(baseOrder())
    expect(html).toContain('ORD-001')
    expect(html).toContain('BPC-157')
    expect(html).not.toContain('NaN')
  })

  it('renders an order whose summary is null', () => {
    expect(() => renderOrderPlaced(baseOrder({ summary: null }))).not.toThrow()
  })

  it('renders an order whose summary has no raw_current_order_total', () => {
    expect(() => renderOrderPlaced(baseOrder({ summary: {} }))).not.toThrow()
  })

  it('shows the total when the summary is present', () => {
    const html = renderOrderPlaced(
      baseOrder({ summary: { raw_current_order_total: { value: 90 } } })
    )
    expect(html).toContain('90,00')
  })

  // query.graph serves money/quantity as raw BigNumber objects on some paths.
  it('does not render "NaN" for BigNumber-shaped unit_price', () => {
    const html = renderOrderPlaced(
      baseOrder({
        items: [
          {
            id: 'item-1',
            product_title: 'BPC-157',
            quantity: 1,
            unit_price: { value: '45' } as never,
          },
        ],
      })
    )
    expect(html).not.toContain('NaN')
  })
})
