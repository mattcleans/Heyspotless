# Spotless Ops

Hey Spotless field-service operations — booking, scheduling, dispatch, billing and
communications. Replaces Housecall Pro Max at `app.heyspotless.com`.

The full specification is [`docs/build-plan.md`](docs/build-plan.md). The centrepiece
is a dispatch engine that spends guaranteed W-2 hours before buying any labour, then
prices the remainder against the true marginal cost of each employee **for that
specific job** — something no off-the-shelf field-service tool does.

## Running it

**Node 20.9 or newer** — Next 16 requires it, and on an older Node the failure does
not name the version as the cause. `package.json` declares the floor, so `npm install`
will warn you.

No credentials are needed. In demo mode the whole admin UI runs off in-memory
fixtures with no Supabase, Stripe, or Twilio connection.

```bash
node -v              # expect v20.9+
npm install
npm run dev          # http://localhost:3000/admin/customers
```

The first request to each route compiles it, so the very first page load takes a few
seconds even after the server says `Ready`. That is Turbopack doing its job, not a
hang.

Records you create in demo mode live in memory and are gone when the server restarts.
The fixtures are not — they are a fixed set the engine tests rely on.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, demo fixtures |
| `npm test` | Vitest — pricing, dispatch and billing suites |
| `npm run test:zones` | The same suite under `TZ=UTC` **and** `TZ=America/Chicago`. What CI runs — scheduling and due dates must not depend on the server's zone, and pinning the suite to one zone would hide it |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `./scripts/verify-migrations.sh` | Replays all migrations against a local Postgres, then asserts the published price table, the money invariants, the refund policy, saved-card defaults, webhook lease recovery, one-collection-per-obligation, and the role permissions — including several genuinely concurrent connections |

## Layout

```
src/lib/pricing/      price book + quote engine
src/lib/dispatch/     marginal cost, eligibility gate, offer ladder, routing, engine
src/lib/billing/      invoice arithmetic, refund policy, auto-charge decisions,
                      collection reconciliation, Stripe event mapping
src/lib/time/         the business calendar — America/Chicago, and calendar days
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
auto-charge, tips and refunds — is switched off: it turns on when
`STRIPE_SECRET_KEY` is set, and `BILLING_ENABLED=0` holds it off while underwriting
is pending. Until then the customer screen shows real balances and says plainly that
payments are not live, rather than offering a button that fails.

The money rules are written down in [`docs/money-policy.md`](docs/money-policy.md):
what a refund does to what is owed, how an obligation is collected exactly once, and
what happens when Stripe's answer never arrives.

### Recurring scheduling is NOT built

Booking a clean with a recurring frequency books **one** clean, at the recurring
rate. It does not create the series: choosing "Weekly" does not put next week's visit
on the board, and nothing in the app will. Generating a series, skipping a week,
moving a day, and holding a rate across a price change are all unbuilt.

This is called out here, in the booking form itself, and in
[`docs/release-readiness.md`](docs/release-readiness.md), because the dropdown reads
exactly like the one in a tool that does create the series — and the cost of the
wrong assumption is a customer waiting for a cleaner nobody booked. Keep recurring
customers in Housecall Pro until it exists.

Twilio, a live Supabase project and the Vercel deploy wait on the checklist in
[`docs/setup.md`](docs/setup.md) — **start the A2P 10DLC filing first**, carrier
approval takes one to three weeks and it gates everything customer-facing.
