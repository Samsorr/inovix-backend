import type { EmailLocale } from '../../../lib/email-locale'
import { ORDER_PLACED_I18N, ORDER_SHIPPED_I18N } from './email-i18n'
import { ORDER_PLACED } from './order-placed'
import { ORDER_SHIPPED } from './order-shipped'

/**
 * The single source of truth for "what may the operator edit before sending".
 *
 * The admin form, the validator, the preview and the send path all read this
 * list, so adding a field is a one-line change that shows up everywhere.
 *
 * Keys MUST match the existing i18n keys in `email-i18n.ts`. `subject` and
 * `trackingUrl` are the two exceptions and are handled specially by the send
 * path: `subject` goes to `data.emailOptions.subject`, `trackingUrl` replaces
 * the first tracked label's URL inside the template.
 *
 * Labels are Dutch because they are operator UI. The defaults come from the
 * customer's locale, so a German customer prefills German text.
 */

export type EditableFieldType = 'text' | 'textarea' | 'url'

export type EditableFieldContext = {
  locale: EmailLocale
  /** The composed notification `data` payload for this email. */
  data: Record<string, any>
}

export type EditableField = {
  /** Also the key inside `data.overrides`. Matches the i18n key. */
  key: string
  /** Dutch label for the admin form. */
  label: string
  type: EditableFieldType
  maxLength: number
  defaultFor: (ctx: EditableFieldContext) => string
}

function displayId(ctx: EditableFieldContext): string | number {
  return ctx.data?.order?.display_id ?? ''
}

function firstTrackingUrl(ctx: EditableFieldContext): string {
  const labels = Array.isArray(ctx.data?.labels) ? ctx.data.labels : []
  for (const label of labels) {
    if (label?.tracking_url) return String(label.tracking_url)
  }
  return ''
}

const shipped = (locale: EmailLocale) => ORDER_SHIPPED_I18N[locale] ?? ORDER_SHIPPED_I18N.nl
const placed = (locale: EmailLocale) => ORDER_PLACED_I18N[locale] ?? ORDER_PLACED_I18N.nl

const ORDER_SHIPPED_FIELDS: EditableField[] = [
  {
    key: 'subject',
    label: 'Onderwerp',
    type: 'text',
    maxLength: 200,
    defaultFor: (c) => shipped(c.locale).subject(displayId(c)),
  },
  {
    key: 'heading',
    label: 'Kop',
    type: 'text',
    maxLength: 120,
    defaultFor: (c) => shipped(c.locale).heading,
  },
  {
    key: 'body',
    label: 'Inleiding',
    type: 'textarea',
    maxLength: 2000,
    defaultFor: (c) => shipped(c.locale).body,
  },
  {
    key: 'trackingHeading',
    label: 'Kop trackingblok',
    type: 'text',
    maxLength: 120,
    defaultFor: (c) => shipped(c.locale).trackingHeading,
  },
  {
    key: 'trackingBody',
    label: 'Tekst trackingblok',
    type: 'textarea',
    maxLength: 1000,
    defaultFor: (c) => shipped(c.locale).trackingBody,
  },
  {
    key: 'trackButton',
    label: 'Knoptekst',
    type: 'text',
    maxLength: 60,
    defaultFor: (c) => shipped(c.locale).trackButton,
  },
  // Empty when the order has no tracked label. That is fine: this template is
  // only offered for orders that have one, and the route refuses to compose
  // otherwise.
  {
    key: 'trackingUrl',
    label: 'Tracking-link',
    type: 'url',
    maxLength: 500,
    defaultFor: (c) => firstTrackingUrl(c),
  },
]

const ORDER_PLACED_FIELDS: EditableField[] = [
  {
    key: 'subject',
    label: 'Onderwerp',
    type: 'text',
    maxLength: 200,
    defaultFor: (c) => placed(c.locale).subject(displayId(c)),
  },
  {
    key: 'heading',
    label: 'Kop',
    type: 'text',
    maxLength: 120,
    defaultFor: (c) => placed(c.locale).heading,
  },
  {
    key: 'body',
    label: 'Inleiding',
    type: 'textarea',
    maxLength: 2000,
    defaultFor: (c) => placed(c.locale).body,
  },
]

const REGISTRY: Record<string, EditableField[]> = {
  [ORDER_SHIPPED]: ORDER_SHIPPED_FIELDS,
  [ORDER_PLACED]: ORDER_PLACED_FIELDS,
}

export const EDITABLE_TEMPLATES: string[] = Object.keys(REGISTRY)

export function editableFieldsFor(template: string): EditableField[] {
  return REGISTRY[template] ?? []
}

export function isEditableTemplate(template: string): boolean {
  return template in REGISTRY
}
