# React Email Components Reference

Complete API reference for all `@react-email/components` (v1.0+).

## Table of Contents

- [Html](#html)
- [Head](#head)
- [Font](#font)
- [Preview](#preview)
- [Body](#body)
- [Container](#container)
- [Section](#section)
- [Row](#row)
- [Column](#column)
- [Text](#text)
- [Heading](#heading)
- [Link](#link)
- [Button](#button)
- [Img](#img)
- [Hr](#hr)
- [Tailwind](#tailwind)
- [Markdown](#markdown)
- [CodeBlock](#codeblockcodeblock)
- [CodeInline](#codeinline)

---

## Html

Root element. Wraps the entire email. Renders `<html>`.

```tsx
<Html lang="en" dir="ltr">
  {/* Head, Tailwind, Body */}
</Html>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `lang` | `string` | `"en"` | Language attribute |
| `dir` | `"ltr" \| "rtl"` | `"ltr"` | Text direction |

Always set `lang` for accessibility. Place `<Tailwind>` either inside or wrapping `<Html>` — both work.

---

## Head

Renders `<head>`. Place inside `<Html>`, before `<Body>`. Contains `<Font>` declarations and any `<meta>` tags.

```tsx
<Html lang="en">
  <Head>
    <Font fontFamily="Roboto" fallbackFontFamily="Verdana" />
    <meta name="color-scheme" content="light" />
  </Head>
  <Body>...</Body>
</Html>
```

Self-closing `<Head />` is fine if you have no fonts or meta tags.

---

## Font

Declares a web font. Must be placed inside `<Head>`. Web font support varies across email clients — always provide `fallbackFontFamily`.

```tsx
<Head>
  <Font
    fontFamily="Inter"
    fallbackFontFamily="Arial"
    webFont={{
      url: "https://fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_fjbvMwCp50SjIa2JL7W0Q5n-wU.woff2",
      format: "woff2",
    }}
    fontWeight={400}
    fontStyle="normal"
  />
</Head>
```

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `fontFamily` | `string` | Yes | Font family name |
| `fallbackFontFamily` | `string \| string[]` | Yes | Fallback when web font fails |
| `webFont` | `{ url: string; format: string }` | No | Web font source |
| `fontWeight` | `number \| string` | No | Font weight |
| `fontStyle` | `"normal" \| "italic"` | No | Font style |

Safe fallback families: `Arial`, `Verdana`, `Georgia`, `Times New Roman`, `Courier New`, `Helvetica`.

---

## Preview

Hidden text shown in the inbox preview alongside the subject line. Content is visible in inbox list views but hidden in the email body.

```tsx
<Preview>Your order #1234 has shipped!</Preview>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `string` | Preview text content |

Keep preview text under ~90 characters — email clients truncate beyond that. Place immediately after `<Head>` and before `<Body>`. If you skip this component, email clients will pull preview text from the first visible text in the body.

---

## Body

The `<body>` element. Set the overall background color and font family here.

```tsx
<Body className="bg-gray-100 font-sans">
  <Container>...</Container>
</Body>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

---

## Container

Centers content and constrains width. Renders a centered `<table>` under the hood — the email-safe way to center content.

```tsx
<Container className="mx-auto py-10 px-5 max-w-xl">
  {/* Sections, content */}
</Container>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

Typical max-width: `max-w-xl` (576px) or `max-w-[600px]`. This is the standard email content width.

---

## Section

Groups related content blocks. Renders a `<table>` wrapper. Use for visual sections (header area, content area, footer area).

```tsx
<Section className="bg-white rounded-lg p-8">
  <Heading>...</Heading>
  <Text>...</Text>
</Section>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

---

## Row

Creates a table row for horizontal layouts. Must contain `Column` children. Renders a `<table>` with `<tr>`.

```tsx
<Row>
  <Column className="w-1/2">Left</Column>
  <Column className="w-1/2">Right</Column>
</Row>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

Column widths must add up to 100% (or the container width). Use Tailwind fractions: `w-1/2`, `w-1/3`, `w-2/3`, `w-1/4`, `w-3/4`.

---

## Column

A table cell inside a `Row`. Never use outside a `Row`.

```tsx
<Row>
  <Column className="w-1/3 p-2 align-top">
    <Img src="https://..." alt="Product" width="150" height="150" />
  </Column>
  <Column className="w-2/3 p-2 align-top">
    <Text>Product description...</Text>
  </Column>
</Row>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

Use `align-top` (or `style={{ verticalAlign: "top" }}`) to prevent content from centering vertically, which is the default table cell behavior.

---

## Text

Renders a `<p>` element. The primary text component.

```tsx
<Text className="text-base leading-6 text-gray-600 m-0 mb-4">
  Your paragraph content here.
</Text>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

Reset margins with `m-0` and set only the margin you need (usually `mb-4`). Default `<p>` margins vary across email clients.

---

## Heading

Renders `<h1>` through `<h6>`. Defaults to `<h1>`.

```tsx
<Heading as="h2" className="text-xl font-bold text-gray-900 m-0 mb-4">
  Section Title
</Heading>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `as` | `"h1" \| "h2" \| "h3" \| "h4" \| "h5" \| "h6"` | `"h1"` | HTML heading level |
| `className` | `string` | | Tailwind classes |
| `style` | `React.CSSProperties` | | Inline styles |

Always reset margins with `m-0` and add explicit spacing.

---

## Link

Renders an `<a>` element.

```tsx
<Link href="https://example.com" className="text-indigo-600 underline">
  View in browser
</Link>
```

| Prop | Type | Description |
|------|------|-------------|
| `href` | `string` | URL (must be absolute) |
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |
| `target` | `string` | Link target (e.g. `"_blank"`) |

Always use absolute URLs.

---

## Button

A CTA link that renders as a visually styled button. Under the hood it's an `<a>` tag — not a `<button>` (which doesn't work in email). The `href` prop is required.

```tsx
<Button
  href="https://example.com/action"
  className="bg-indigo-600 rounded-md text-white text-base font-semibold no-underline text-center block py-3 px-6"
>
  Get Started
</Button>
```

| Prop | Type | Description |
|------|------|-------------|
| `href` | `string` | URL (must be absolute, required) |
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

Always include `no-underline` (or `textDecoration: "none"`) and `block text-center` for consistent rendering. The `block` display ensures proper width/padding across clients.

---

## Img

Renders an `<img>` element. Always provide `width`, `height`, and `alt`.

```tsx
<Img
  src="https://cdn.example.com/logo.png"
  alt="Company Logo"
  width="150"
  height="50"
  className="block mx-auto"
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `src` | `string` | Absolute URL to image (PNG or JPEG only) |
| `alt` | `string` | Alt text (required for accessibility) |
| `width` | `string \| number` | Width in pixels |
| `height` | `string \| number` | Height in pixels |
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

For responsive images that scale down: set `width` to the natural width and add `className="w-full max-w-full h-auto"`. The `width` attribute acts as a maximum, and `w-full` makes it fill the container.

---

## Hr

Horizontal rule. Renders `<hr>`.

```tsx
<Hr className="border-gray-200 my-6" />
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |

---

## Tailwind

Wraps email content to enable Tailwind CSS class utilities. Inlines styles at render time for email client compatibility.

```tsx
<Tailwind
  config={{
    presets: [pixelBasedPreset],
    theme: {
      extend: {
        colors: {
          brand: "#007bff",
        },
      },
    },
  }}
>
  {/* Html, Body, etc. */}
</Tailwind>
```

| Prop | Type | Description |
|------|------|-------------|
| `config` | `TailwindConfig` | Tailwind configuration object |

The `pixelBasedPreset` import from `@react-email/components` is mandatory — it converts rem to px.

---

## Markdown

Renders Markdown content as email-safe HTML. Useful for user-generated content or content from a CMS.

```tsx
import { Markdown } from "@react-email/components";

<Markdown
  markdownCustomStyles={{
    h1: { fontSize: "24px", fontWeight: "bold" },
    p: { fontSize: "16px", lineHeight: "26px" },
    a: { color: "#007bff" },
  }}
>
  {`# Hello\n\nThis is **bold** and this is a [link](https://example.com).`}
</Markdown>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `string` | Markdown content |
| `markdownCustomStyles` | `Record<string, React.CSSProperties>` | Custom styles per HTML element |
| `markdownContainerStyles` | `React.CSSProperties` | Wrapper container styles |

---

## CodeBlock

Syntax-highlighted code block. Useful for developer-facing emails.

```tsx
import { CodeBlock, dracula } from "@react-email/components";

<CodeBlock
  code="const x = 42;"
  language="javascript"
  theme={dracula}
  className="rounded-lg"
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `code` | `string` | Code content |
| `language` | `string` | Language for highlighting |
| `theme` | `object` | Syntax theme (import from `@react-email/components`) |
| `className` | `string` | Tailwind classes |

---

## CodeInline

Inline code span for embedding code within text.

```tsx
<Text>
  Run <CodeInline className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono">npm install</CodeInline> to get started.
</Text>
```

| Prop | Type | Description |
|------|------|-------------|
| `children` | `string` | Code content |
| `className` | `string` | Tailwind classes |
| `style` | `React.CSSProperties` | Inline styles |
