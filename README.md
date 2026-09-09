# Spotless Ops

Hey Spotless field-service operations — booking, scheduling, dispatch, billing and
communications. Replaces Housecall Pro Max at `app.heyspotless.com`.

The full specification is [`docs/build-plan.md`](docs/build-plan.md). The centrepiece
is a dispatch engine that spends guaranteed W-2 hours before buying any labour, then
prices the remainder against the true marginal cost of each employee **for that
specific job** — something no off-the-shelf field-service tool does.

## Running it

No credentials are needed. In demo mode the whole admin UI runs off in-memory
fixtures with no Supabase, Stripe, or Twilio connection.

```bash
npm install
npm run dev          # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, demo fixtures |
| `npm test` | Vitest — pricing, dispatch and billing suites |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `./scripts/verify-migrations.sh` | Replays all migrations against a local Postgres, then asserts the published price table, the invoice-balance invariants, and that a replayed payment or refund is a no-op |

## Layout

```
src/lib/pricing/      price book + quote engine
src/lib/dispatch/     marginal cost, eligibility gate, offer ladder, routing, engine
src/lib/billing/      invoice arithmetic, auto-charge decisions, Stripe event mapping
src/lib/stripe/       SDK boundary — client, config flags, cron guard
src/app/admin/        dispatch board, quote builder, price book
src/app/api/          Stripe webhook, checkout, saved cards, auto-charge sweep, refunds
src/app/cleaner/      cleaner PWA (scaffolded)
src/app/customer/     customer portal — balances, saved card, autopay
supabase/migrations/  schema, price book, row-level security, billing
docs/                 build plan, setup checklist, decisions
```

## Why the tests matter

The pricing and dispatch suites assert against figures published independently of
this code — the Hey Spotless pricelist effective 9 August 2026, and the cost tables
in the build plan. All 27 quote totals are checked in **both** TypeScript and SQL, so
the two implementations cannot silently drift apart.

Two discrepancies in the source documents are recorded as tests rather than
reproduced; see [`docs/decisions.md`](docs/decisions.md).

Billing is tested the same way. The money rules are pure functions, so what an
invoice owes, when a card may be charged, and what a Stripe event means are all
asserted without a database, a key or a network — and the same invoice-balance
assertions run against the SQL in `verify-migrations.sh`, including the proof that a
replayed webhook does not move money twice.

## Status

Phases 1–3 and 5 of the build plan are built. Billing — Checkout, saved cards,
auto-charge, tips and refunds — is complete and switched off: it turns on when
`STRIPE_SECRET_KEY` is set, and `BILLING_ENABLED=0` holds it off while underwriting
is pending. Until then the customer screen shows real balances and says plainly that
payments are not live, rather than offering a button that fails.

Twilio, a live Supabase project and the Vercel deploy wait on the checklist in
[`docs/setup.md`](docs/setup.md) — **start the A2P 10DLC filing first**, carrier
approval takes one to three weeks and it gates everything customer-facing.
