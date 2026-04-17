# React Email Styling Guide

## Tailwind CSS in Emails

Tailwind is the recommended styling approach. The `<Tailwind>` component processes className values and inlines them as `style` attributes at render time, which is exactly what email clients need.

### Required Setup

```tsx
import { Tailwind, pixelBasedPreset } from "@react-email/components";

<Tailwind config={{ presets: [pixelBasedPreset] }}>
  {/* all email content */}
</Tailwind>
```

The `pixelBasedPreset` converts rem-based Tailwind utilities to pixel values. Without it, `text-base` renders as `1rem` — which email clients either ignore or render inconsistently.

### Extending the Theme

Add brand colors, custom spacing, or font families:

```tsx
<Tailwind
  config={{
    presets: [pixelBasedPreset],
    theme: {
      extend: {
        colors: {
          brand: {
            DEFAULT: "#007bff",
            dark: "#0056b3",
            light: "#66b2ff",
          },
          accent: "#28a745",
          muted: "#6c757d",
        },
        fontSize: {
          tiny: "11px",
        },
      },
    },
  }}
>
```

Then use in components: `className="text-brand bg-accent"`.

## Safe CSS Properties

These CSS properties work reliably across all major email clients (Gmail, Outlook, Apple Mail, Yahoo):

### Typography
- `color`, `font-family`, `font-size`, `font-weight`, `font-style`
- `line-height`, `letter-spacing`, `text-align`, `text-decoration`
- `text-transform`, `word-break`, `word-spacing`

### Box Model
- `background-color`, `background-image` (with caveats)
- `border`, `border-radius` (limited in Outlook)
- `margin`, `padding`
- `width`, `max-width`, `min-width`
- `height`, `max-height`, `min-height`

### Table
- `vertical-align`, `border-collapse`, `border-spacing`
- `table-layout`

## Unsafe CSS (Avoid)

These properties are silently stripped or ignored by one or more major email clients:

| Property | Problem |
|----------|---------|
| `display: flex` | Ignored by Outlook, Gmail web |
| `display: grid` | Ignored by most clients |
| `position: absolute/relative/fixed` | Stripped by Gmail |
| `float` | Inconsistent across clients |
| `box-shadow` | Stripped by Gmail, Outlook |
| `opacity` | Limited support |
| `transform` | Not supported |
| `animation`, `transition` | Not supported |
| `rem`, `em`, `vh`, `vw` units | Inconsistent — use `px` |
| `calc()` | Limited support |
| `var()` / CSS custom properties | Not supported |
| Media queries (`@media`) | Gmail strips them |
| `:hover`, `:focus` pseudo-classes | Not supported |
| `dark:` / `light:` theme variants | Not supported |

## Inline Styles (Alternative)

If you prefer inline styles over Tailwind, use `React.CSSProperties` objects. Use `as const` for enum-like values:

```tsx
const container: React.CSSProperties = {
  maxWidth: "600px",
  margin: "0 auto",
  padding: "20px",
  backgroundColor: "#ffffff",
};

const heading: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: "bold",
  textAlign: "center" as const,
  color: "#333333",
  margin: "0 0 24px",
};

const button: React.CSSProperties = {
  backgroundColor: "#007bff",
  borderRadius: "5px",
  color: "#ffffff",
  fontSize: "16px",
  fontWeight: "bold",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "inline-block",
  padding: "12px 30px",
};
```

### Sharing Styles

Extract shared styles to a separate file when templates share common styling:

```tsx
// emails/shared/styles.ts
export const colors = {
  brand: "#007bff",
  text: "#333333",
  muted: "#6c757d",
  background: "#f6f9fc",
  white: "#ffffff",
  border: "#e5e7eb",
};

export const typography = {
  heading: {
    fontSize: "24px",
    fontWeight: "bold",
    color: colors.text,
    margin: "0 0 16px",
  } as React.CSSProperties,
  body: {
    fontSize: "16px",
    lineHeight: "26px",
    color: colors.text,
  } as React.CSSProperties,
  small: {
    fontSize: "12px",
    color: colors.muted,
    lineHeight: "22px",
  } as React.CSSProperties,
};
```

## Dark Mode

Dark mode support in email is limited. Most email clients that support dark mode will automatically invert colors. You can hint at your preferred scheme:

```tsx
<Head>
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
</Head>
```

For explicit dark mode styling, use hardcoded dark colors on `Body` and `Container`:

```tsx
<Body className="bg-[#151516]">
  <Container className="bg-black text-white">
```

Tailwind's `dark:` prefix does **not** work in email — it relies on media queries that email clients strip.

## Web Fonts

Web font support is limited. Gmail, Outlook (Windows), and Yahoo ignore web fonts entirely. Always specify `fallbackFontFamily`:

```tsx
<Head>
  <Font
    fontFamily="Inter"
    fallbackFontFamily={["Helvetica", "Arial", "sans-serif"]}
    webFont={{
      url: "https://fonts.gstatic.com/s/inter/v18/...",
      format: "woff2",
    }}
    fontWeight={400}
    fontStyle="normal"
  />
</Head>
```

Clients that support web fonts: Apple Mail, iOS Mail, Thunderbird, some Samsung Mail versions.

For maximum compatibility, use system font stacks: `font-sans` in Tailwind maps to `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.

## Border Radius

`border-radius` works in most modern email clients but is **ignored by Outlook on Windows** (which uses the Word rendering engine). For elements where rounded corners are critical:

- On `Button`: the React Email component handles this gracefully — the button still looks good in Outlook, just with square corners.
- On `Section`/`Container`: treat rounded corners as progressive enhancement that degrades gracefully.

## Background Images

Background images (`background-image`) work in most clients except Outlook on Windows. If you need background images in Outlook, you would need VML (Vector Markup Language) — which React Email does not abstract. For most use cases, use a solid `background-color` fallback and treat the background image as enhancement.
