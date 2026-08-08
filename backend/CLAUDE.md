# inovix-backend — Medusa v2 backend

Medusa.js v2 backend for Inovix (EU peptide research e-commerce). Deploys to
Railway. This `backend/` folder is the app; the git root is one level up at
`inovix-backend/` and tracks `backend/**` (default branch `master`).

> Architecture + flows: `../../docs/architecture/OVERVIEW.md`. Detailed rules:
> the `.claude/skills/` at the repo root (inovix-payments-opacity,
> inovix-deploy-ops, inovix-dhl-fulfillment, inovix-checkout-orders,
> inovix-conventions). Hard rules are surfaced here.

## Deploy + migrations
- `git push origin master` -> Railway auto-deploys. Verify: deployment SUCCESS,
  `GET /health` 200, running commit sha matches.
- **Prod DB migrations are MANUAL.** Railway's init skips `medusa db:migrate`
  on a seeded DB, so new module tables/columns will NOT auto-create. Run
  `medusa db:migrate` against the prod public DB URL yourself
  (`tramway.proxy.rlwy.net:36483`; re-derive from the live `DATABASE_PUBLIC_URL`).
- Railway has no working CLI for the workspace token; use the GraphQL API
  (see inovix-deploy-ops skill). Roll back on any failed health check.

## Hard rules
- **Mollie opacity** (inovix-payments-opacity skill): the literal `inovix` must
  never reach Mollie. The payment provider is `payment-via-broker`
  (`pp_via_broker_via_broker`); it talks to the Tencore broker over HMAC with a
  generic UA and opaque `client_id`, and only ever sends a
  `payments-relay.nl/r/<token>` return URL. Never add customer fields to the
  broker call. Mollie access is read-only.
- **Import core workflows from `@medusajs/medusa/core-flows`**, NOT
  `@medusajs/core-flows` (the latter is a transitive dep | local builds resolve
  it but Railway's strict pnpm install fails TS2307). This has bitten multiple
  features.
- No em dashes; Dutch in customer-facing strings (emails, validation messages).
- Resend: the Inovix account key only (`resend-inovix-api-key`), from
  `info@inovix.nl`. Never the Tencore Resend account.

## Key subsystems
- `src/modules/payment-via-broker/` — Mollie-via-broker payment provider +
  return-token (Cloudflare KV) + HMAC callback verification.
- `src/api/payments/broker-callback/` — inbound status callback. Verifies HMAC
  (raw body preserved in `src/api/middlewares.ts`) and runs
  `processPaymentWorkflow` to complete the cart. `src/jobs/reconcile-broker-payments.ts`
  is the every-5-min safety net for paid-but-unreturned carts.
- `src/modules/dhl-parcel*` + `src/workflows/create-dhl-parcel-shipment/` —
  DHL Parcel NL fulfillment + inventory (provider id is COMPOSED:
  `dhl-parcel_dhl-parcel`). See the inovix-dhl-fulfillment skill for the many
  gotchas (TEXT weight, trailing-star query.graph, idempotent labelIds,
  shared test/live DHL account).
- `src/modules/email-notifications/` + `src/subscribers/` — Resend transactional
  emails; dedup via idempotency keys (a real re-send needs a UNIQUE key).
- `src/modules/minio-file/` — patched for Cloudflare R2 (`MINIO_PUBLIC_URL`).
- `src/modules/telegram-ops/` + `src/subscribers/tg-*` + `src/api/webhooks/telegram/`
  | operator Telegram bot (@InovixOpsBot): notifications + read commands, no
  money actions. Idempotent sends via the `telegram_ops_event` table. Order
  data MUST go through `commands/order-data.ts` helpers (orderTotal,
  itemQuantity, firstNumber) | live query.graph returns null relation
  elements, unreliable order.total, and quantities on items.detail as raw
  bigNumber objects. See the inovix-telegram-ops skill.

## Code conventions
- Medusa module update methods take the id IN the data:
  `updateX({ id, ...fields })`. The `(selector, data)` form silently no-ops.
- Direct `query.graph({fields})`: trailing-star nested (`items.variant.*`),
  never leading-star on a dotted path; never traverse cross-module links;
  it does NOT compute `fulfillment_status`.
- Pricing rule values must be numbers, not strings.

## Tests
- Jest (`npx jest <path>`). `tsc --noEmit` must stay clean.
- The suite is fully green (2026-08-08). The old "known pre-existing failures"
  note naming `minio-file/service.test.ts` and `subscribers/order-placed.test.ts`
  was stale; both pass. Treat any red as yours.
- `email-notifications/__tests__/templates.test.tsx` is a genuine
  load-sensitive flake (roughly 1 run in 4 under parallel load: "A component
  suspended while responding to synchronous input" from `renderToStaticMarkup`).
  Re-run it in isolation before concluding anything from it.
- Mocks must model the real `query.graph` shapes or the test is worthless:
  quantities live on `items.detail` and come back `undefined` on `items`,
  relation arrays contain null elements, and `fulfillment_status` is not
  computed. A mock returning one object for every call silently makes a
  two-step lookup pass without ever running.
- `medusa exec` against prod loads `**/*.ts` incl. test files (`jest is not
  defined`); rename test files out of the way when running exec scripts.
