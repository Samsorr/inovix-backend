---
name: react-email
description: "Build email templates with react-email components (v1.0+) and render them server-side for Resend or any email provider. Use this skill whenever creating, editing, debugging, or reviewing React Email templates — even for simple tasks like 'add a button to the welcome email' or 'create a password reset email'. The skill contains critical email client compatibility rules (no flexbox, no rem units, pixelBasedPreset requirement, Outlook conditional comments) that prevent broken rendering in production. Triggers on: React Email components, email templates, react-email component imports, Tailwind in emails, email layout, email styling, Html/Head/Body/Container/Section/Row/Column/Text/Button/Img/Link/Hr/Preview components, render from react-email, PreviewProps, pixelBasedPreset, email client compatibility, Outlook rendering, Gmail rendering."
---

# React Email Skill

Build production-ready email templates using `@react-email/components` (v1.0+). React Email provides unstyled, composable React components that compile to cross-client-compatible HTML. Templates are rendered server-side via `@react-email/render` and sent through Resend (or any provider that accepts HTML strings).

## Quick Start Template

Every email template follows this structure:

```tsx
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Heading,
  Text,
  Button,
  Hr,
  Tailwind,
  pixelBasedPreset,
} from "@react-email/components";

interface MyEmailProps {
  name: string;
  actionUrl: string;
}

export default function MyEmail({ name, actionUrl }: MyEmailProps) {
  return (
    <Html lang="en">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Brief preview text shown in inbox list</Preview>
        <Body className="bg-gray-100 font-sans">
          <Container className="mx-auto py-10 px-5 max-w-xl">
            <Section className="bg-white rounded-lg p-8">
              <Heading className="text-2xl font-bold text-gray-900 m-0 mb-6">
                Hello {name}
              </Heading>
              <Text className="text-base leading-6 text-gray-600 m-0 mb-4">
                Your message content here.
              </Text>
              <Button
                href={actionUrl}
                className="bg-indigo-600 rounded-md text-white text-base font-semibold no-underline text-center block py-3 px-6 my-6"
              >
                Take Action
              </Button>
              <Hr className="border-gray-200 my-6" />
              <Text className="text-sm text-gray-400 m-0">
                Footer text here.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

MyEmail.PreviewProps = {
  name: "Jane",
  actionUrl: "https://example.com/action",
} satisfies MyEmailProps;
```

## Core Rules

These rules prevent broken rendering across email clients. They exist because email clients (especially Outlook, Gmail, and Yahoo) use severely limited HTML/CSS rendering engines that silently discard modern CSS.

### 1. Always use `pixelBasedPreset` with Tailwind

Email clients do not support `rem` units. The `pixelBasedPreset` converts Tailwind's rem-based utilities to pixels. Without it, font sizes, spacing, and layout will break in most clients.

```tsx
import { Tailwind, pixelBasedPreset } from "@react-email/components";

<Tailwind config={{ presets: [pixelBasedPreset] }}>
  {/* all email content */}
</Tailwind>
```

### 2. No flexbox, no grid, no position absolute

Email clients render HTML using table-based engines. Use `Row` and `Column` components for multi-column layouts — they compile to `<table>` elements under the hood.

```tsx
// CORRECT — Row/Column compiles to tables
<Row>
  <Column className="w-1/2 p-2 align-top">Left</Column>
  <Column className="w-1/2 p-2 align-top">Right</Column>
</Row>

// WRONG — silently ignored by most email clients
<div style={{ display: "flex" }}>...</div>
<div style={{ display: "grid" }}>...</div>
```

### 3. No SVG or WEBP images

Use PNG or JPEG only. Always use absolute URLs for image `src` — relative paths won't resolve in email clients.

### 4. No media queries or theme selectors

Tailwind's `dark:`, `md:`, `hover:` variants do not work in email. Design for a single viewport.

### 5. Explicit width and height on images

Always set `width` and `height` on `<Img>` to prevent layout shifts while images load.

### 6. Default export + PreviewProps

The default export is what React Email's dev server and `render()` use. Attach `PreviewProps` for the dev preview UI and for testing.

## Component Reference

All components are imported from `@react-email/components`. See `references/components.md` for the full API of every component including all props, or consult the quick reference below:

| Component | Purpose | Key Props |
|-----------|---------|-----------|
| `Html` | Root wrapper, sets `lang` and `dir` | `lang`, `dir` |
| `Head` | Contains `<meta>` tags, `Font` | children |
| `Preview` | Inbox preview text (hidden in body) | children (string) |
| `Body` | `<body>` element | `className`, `style` |
| `Container` | Centered content wrapper (max-width) | `className`, `style` |
| `Section` | Groups content blocks | `className`, `style` |
| `Row` | Table row for column layouts | `className`, `style` |
| `Column` | Table cell inside `Row` | `className`, `style` |
| `Text` | `<p>` element | `className`, `style` |
| `Heading` | `<h1>`-`<h6>` element | `as` (`"h1"`-`"h6"`), `className` |
| `Link` | `<a>` element | `href`, `className`, `style` |
| `Button` | CTA link styled as a button | `href`, `className`, `style` |
| `Img` | `<img>` element | `src`, `alt`, `width`, `height` |
| `Hr` | Horizontal rule | `className`, `style` |
| `Font` | Web font declaration (inside `Head`) | `fontFamily`, `fallbackFontFamily`, `webFont` |
| `Tailwind` | Tailwind CSS provider | `config` |
| `Markdown` | Renders markdown to email-safe HTML | `children`, `markdownCustomStyles` |
| `CodeBlock` | Syntax-highlighted code block | `code`, `language`, `theme` |
| `CodeInline` | Inline code span | `children`, `className` |

## Styling Approach

React Email supports two styling methods. **Tailwind is recommended** because it produces inline styles at build time, which is what email clients need.

### Tailwind (recommended)

Wrap content in `<Tailwind>` with `pixelBasedPreset`. Use className for all styling. Extend the theme for brand colors:

```tsx
<Tailwind
  config={{
    presets: [pixelBasedPreset],
    theme: {
      extend: {
        colors: {
          brand: "#007bff",
          accent: "#28a745",
        },
      },
    },
  }}
>
```

### Inline styles (alternative)

Use `style` prop with `React.CSSProperties` objects. Required `as const` assertion for `textAlign`:

```tsx
const heading = {
  fontSize: "24px",
  fontWeight: "bold",
  textAlign: "center" as const,
};
```

See `references/styling.md` for the complete styling guide including dark mode, font loading, and safe CSS properties.

## Layout Patterns

See `references/patterns.md` for complete template patterns including:

- Two-column and three-column layouts
- Header + logo + navigation
- Card-based layouts
- Receipt / order summary tables
- Footer with social links and unsubscribe
- Notification emails
- Newsletter layouts

## Rendering and Sending

```tsx
import { render } from "@react-email/render";
import MyEmail from "./my-email";

// Render to HTML string (server-side)
const html = await render(<MyEmail name="Jane" actionUrl="https://..." />);

// Send via Resend
import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: "hello@example.com",
  to: "user@example.com",
  subject: "Welcome",
  react: <MyEmail name="Jane" actionUrl="https://..." />,
  // OR: html (pre-rendered string)
});
```

Resend accepts either `react` (renders automatically) or `html` (pre-rendered). Use `react` for simplicity; use `html` when you need to cache or log the rendered output.

## TypeScript Patterns

1. **Props interface** — define above the component, export if other code needs it
2. **Default props** — use destructuring defaults for optional props
3. **PreviewProps** — use `satisfies` to type-check preview data without widening
4. **Named + default export** — default export for React Email tooling, named export for programmatic use

```tsx
export interface InviteEmailProps {
  inviterName: string;
  teamName: string;
  inviteUrl: string;
  expiryDays?: number;
}

export default function InviteEmail({
  inviterName,
  teamName,
  inviteUrl,
  expiryDays = 7,
}: InviteEmailProps) {
  // ...
}

InviteEmail.PreviewProps = {
  inviterName: "Alice",
  teamName: "Engineering",
  inviteUrl: "https://example.com/invite/abc",
  expiryDays: 14,
} satisfies InviteEmailProps;

export { InviteEmail };
```

## File Organization

```
emails/
  index.ts          # Re-exports all templates
  welcome.tsx       # One file per template
  invite.tsx
  password-reset.tsx
  order-receipt.tsx
  shared/
    footer.tsx      # Shared sections across templates
    header.tsx
    styles.ts       # Shared style constants (if using inline styles)
```

Each template is a standalone React component. Shared sections (headers, footers) are regular components imported into templates.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Missing `pixelBasedPreset` | Add `presets: [pixelBasedPreset]` to Tailwind config |
| Using `display: flex/grid` | Use `Row` + `Column` components |
| Relative image URLs | Use absolute URLs (`https://...`) |
| SVG or WEBP images | Convert to PNG or JPEG |
| Using `rem` in inline styles | Use `px` values |
| Missing `width`/`height` on `Img` | Always set explicit dimensions |
| Using `dark:` or `md:` variants | Not supported — design for single viewport |
| No `Preview` component | Add `<Preview>` for inbox preview text |
| Forgetting default export | Required by React Email tooling and `render()` |
| Long preview text | Keep under ~90 chars; email clients truncate |
