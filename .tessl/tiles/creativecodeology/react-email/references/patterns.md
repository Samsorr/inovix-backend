# React Email Template Patterns

Reusable patterns for common email template types. All examples use Tailwind with `pixelBasedPreset`.

## Standard Email Structure

Every template follows this hierarchy:

```
Html (lang)
  Tailwind (config with pixelBasedPreset)
    Head (+ Font if needed)
    Preview (inbox preview text)
    Body (background color, font)
      Container (centered, max-width)
        Section (visual groupings)
          Content components
```

## Two-Column Layout

Use `Row` and `Column` — never flexbox. Column widths must total the container width.

```tsx
<Section>
  <Row>
    <Column className="w-1/2 p-4 align-top">
      <Img src="https://..." alt="Feature 1" width="240" height="160" className="w-full h-auto" />
      <Heading as="h3" className="text-lg font-bold m-0 mt-4">Feature One</Heading>
      <Text className="text-sm text-gray-600 m-0 mt-2">Description text.</Text>
    </Column>
    <Column className="w-1/2 p-4 align-top">
      <Img src="https://..." alt="Feature 2" width="240" height="160" className="w-full h-auto" />
      <Heading as="h3" className="text-lg font-bold m-0 mt-4">Feature Two</Heading>
      <Text className="text-sm text-gray-600 m-0 mt-2">Description text.</Text>
    </Column>
  </Row>
</Section>
```

## Three-Column Layout

```tsx
<Row>
  <Column className="w-1/3 p-2 align-top text-center">
    <Img src="https://..." alt="Icon 1" width="48" height="48" className="mx-auto" />
    <Text className="text-sm font-bold m-0 mt-2">Step 1</Text>
  </Column>
  <Column className="w-1/3 p-2 align-top text-center">
    <Img src="https://..." alt="Icon 2" width="48" height="48" className="mx-auto" />
    <Text className="text-sm font-bold m-0 mt-2">Step 2</Text>
  </Column>
  <Column className="w-1/3 p-2 align-top text-center">
    <Img src="https://..." alt="Icon 3" width="48" height="48" className="mx-auto" />
    <Text className="text-sm font-bold m-0 mt-2">Step 3</Text>
  </Column>
</Row>
```

## Header with Logo

```tsx
<Section className="py-6 text-center">
  <Img
    src="https://cdn.example.com/logo.png"
    alt="Company Name"
    width="120"
    height="40"
    className="mx-auto"
  />
</Section>
```

## CTA Button

Full-width, prominent:

```tsx
<Button
  href={actionUrl}
  className="bg-brand text-white text-base font-bold no-underline text-center block py-4 px-6 rounded-md my-6 box-border"
>
  Verify Your Email
</Button>
```

Compact, inline:

```tsx
<Button
  href={actionUrl}
  className="bg-brand text-white text-sm font-semibold no-underline text-center py-2 px-4 rounded"
>
  View Details
</Button>
```

## Info Card / Callout

```tsx
<Section className="bg-blue-50 border border-blue-200 rounded-lg p-6 my-6">
  <Text className="text-sm font-bold text-blue-800 m-0 mb-2">
    Important Notice
  </Text>
  <Text className="text-sm text-blue-700 m-0">
    Your account will be upgraded automatically on March 1st.
  </Text>
</Section>
```

## Order Receipt / Line Items

```tsx
<Section className="my-6">
  <Heading as="h2" className="text-lg font-bold m-0 mb-4">Order Summary</Heading>

  {items.map((item) => (
    <Row key={item.id} className="border-b border-gray-200">
      <Column className="w-3/4 py-3">
        <Text className="text-sm font-medium m-0">{item.name}</Text>
        <Text className="text-xs text-gray-500 m-0 mt-1">Qty: {item.qty}</Text>
      </Column>
      <Column className="w-1/4 py-3 text-right">
        <Text className="text-sm font-medium m-0">${item.price}</Text>
      </Column>
    </Row>
  ))}

  <Hr className="border-gray-300 my-4" />

  <Row>
    <Column className="w-3/4">
      <Text className="text-base font-bold m-0">Total</Text>
    </Column>
    <Column className="w-1/4 text-right">
      <Text className="text-base font-bold m-0">${total}</Text>
    </Column>
  </Row>
</Section>
```

## Key-Value Details

For shipping info, account details, etc.:

```tsx
<Section className="bg-gray-50 rounded-lg p-6 my-6">
  <Row className="mb-2">
    <Column className="w-2/5">
      <Text className="text-sm text-gray-500 m-0">Order Number</Text>
    </Column>
    <Column className="w-3/5">
      <Text className="text-sm font-medium m-0">#ORD-2024-1234</Text>
    </Column>
  </Row>
  <Row className="mb-2">
    <Column className="w-2/5">
      <Text className="text-sm text-gray-500 m-0">Ship To</Text>
    </Column>
    <Column className="w-3/5">
      <Text className="text-sm font-medium m-0">123 Main St, City, ST 12345</Text>
    </Column>
  </Row>
  <Row>
    <Column className="w-2/5">
      <Text className="text-sm text-gray-500 m-0">Estimated Delivery</Text>
    </Column>
    <Column className="w-3/5">
      <Text className="text-sm font-medium m-0">March 20-22, 2025</Text>
    </Column>
  </Row>
</Section>
```

## Footer with Unsubscribe

```tsx
<Section className="mt-8 pt-6 border-t border-gray-200 text-center">
  <Text className="text-xs text-gray-400 m-0 mb-2">
    Company Name, Inc. | 123 Business Ave, City, ST 12345
  </Text>
  <Text className="text-xs text-gray-400 m-0">
    <Link href={unsubscribeUrl} className="text-gray-400 underline">
      Unsubscribe
    </Link>
    {" | "}
    <Link href={preferencesUrl} className="text-gray-400 underline">
      Email Preferences
    </Link>
    {" | "}
    <Link href={privacyUrl} className="text-gray-400 underline">
      Privacy Policy
    </Link>
  </Text>
</Section>
```

## Footer with Social Links

```tsx
<Section className="mt-8 text-center">
  <Row className="mb-4">
    <Column className="text-center">
      <Link href="https://twitter.com/company" className="mx-2">
        <Img src="https://cdn.example.com/twitter.png" alt="Twitter" width="24" height="24" className="inline" />
      </Link>
      <Link href="https://linkedin.com/company/company" className="mx-2">
        <Img src="https://cdn.example.com/linkedin.png" alt="LinkedIn" width="24" height="24" className="inline" />
      </Link>
      <Link href="https://github.com/company" className="mx-2">
        <Img src="https://cdn.example.com/github.png" alt="GitHub" width="24" height="24" className="inline" />
      </Link>
    </Column>
  </Row>
</Section>
```

## Shared Components

Extract repeated sections into components:

### Header Component

```tsx
// emails/shared/header.tsx
import { Section, Img, Hr } from "@react-email/components";

interface HeaderProps {
  logoUrl: string;
  companyName: string;
}

export function Header({ logoUrl, companyName }: HeaderProps) {
  return (
    <Section className="py-6 text-center">
      <Img
        src={logoUrl}
        alt={companyName}
        width="120"
        height="40"
        className="mx-auto"
      />
      <Hr className="border-gray-200 mt-6 mb-0" />
    </Section>
  );
}
```

### Footer Component

```tsx
// emails/shared/footer.tsx
import { Section, Text, Link } from "@react-email/components";

interface FooterProps {
  companyName: string;
  address: string;
  unsubscribeUrl?: string;
}

export function Footer({ companyName, address, unsubscribeUrl }: FooterProps) {
  return (
    <Section className="mt-8 pt-6 border-t border-gray-200 text-center">
      <Text className="text-xs text-gray-400 m-0 mb-2">
        {companyName} | {address}
      </Text>
      {unsubscribeUrl && (
        <Text className="text-xs text-gray-400 m-0">
          <Link href={unsubscribeUrl} className="text-gray-400 underline">
            Unsubscribe
          </Link>
        </Text>
      )}
    </Section>
  );
}
```

### Using Shared Components

```tsx
import { Header } from "./shared/header";
import { Footer } from "./shared/footer";

export default function WelcomeEmail({ name }: WelcomeEmailProps) {
  return (
    <Html lang="en">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Welcome!</Preview>
        <Body className="bg-gray-100 font-sans">
          <Container className="mx-auto py-10 px-5 max-w-xl">
            <Section className="bg-white rounded-lg overflow-hidden">
              <Header logoUrl="https://..." companyName="Acme" />
              {/* Email body content */}
              <Footer
                companyName="Acme, Inc."
                address="123 Main St"
                unsubscribeUrl="https://..."
              />
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
```

## Conditional Content

Use standard React conditionals for dynamic content:

```tsx
{order.status === "shipped" ? (
  <Text>Your order is on its way!</Text>
) : (
  <Text>Your order is being prepared.</Text>
)}

{showUpgradePrompt && (
  <Section className="bg-yellow-50 p-4 rounded-lg my-4">
    <Text className="text-sm m-0">Upgrade to Pro for more features.</Text>
  </Section>
)}
```

## Rendering and Sending

### With Resend (react prop)

```tsx
import { Resend } from "resend";
import WelcomeEmail from "./emails/welcome";

const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: "hello@company.com",
  to: user.email,
  subject: "Welcome to Company",
  react: <WelcomeEmail name={user.name} actionUrl={verifyUrl} />,
});
```

### Pre-rendered HTML

```tsx
import { render } from "@react-email/render";
import WelcomeEmail from "./emails/welcome";

const html = await render(
  <WelcomeEmail name={user.name} actionUrl={verifyUrl} />
);

// Use html string with any email provider
await sendEmail({ to: user.email, subject: "Welcome", html });
```

### Plain Text Version

```tsx
import { render } from "@react-email/render";

const text = await render(
  <WelcomeEmail name={user.name} actionUrl={verifyUrl} />,
  { plainText: true }
);
```

Including a plain text version alongside HTML improves deliverability — spam filters favor multipart emails.
