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
| `./scripts/verify-migrations.sh` | Replays all migrations against a local Postgres, then asserts the published price table, the money invariants, the refund policy, saved-card defaults, webhook lease recovery, one-collection-per-obligation, the offer lifecycle and the role permissions — including several genuinely concurrent connections |

## Layout

```
src/lib/pricing/      price book + quote engine
src/lib/dispatch/     marginal cost, eligibility gate, offer ladder, continuity,
                      routing, engine, and the store that persists decisions
src/lib/billing/      invoice arithmetic, refund policy, auto-charge decisions,
                      collection reconciliation, Stripe event mapping
src/lib/time/         the business calendar — America/Chicago, and calendar days
src/lib/recurring/    when a recurring plan's next visits fall, and generating them
src/lib/stripe/       SDK boundary — client, config flags, cron guard
src/app/admin/        dispatch board, quote builder, price book
src/app/api/          Stripe webhook, checkout, saved cards, auto-charge sweep,
                      refunds, recurring generation, offer accept/decline
src/app/cleaner/      cleaner PWA — today's route, and answering an offer
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

### Recurring scheduling

Frequency and repeating are two separate choices, on purpose. The **frequency sets
the rate** — a fortnightly clean is priced fortnightly whether or not it repeats.
**"Repeat this automatically"** starts a standing plan.

A plan stores the **agreed rate**, so a later price-book change cannot quietly raise
a long-standing customer. Visits are materialised about six weeks ahead by
`/api/recurring/generate`, which is idempotent on `(plan, occurrence date)` —
running it twice, or three times at once, produces one job per visit. Any single
visit can be skipped without moving the ones after it, and a skip is a row with a
reason, not a deletion.

The cadence derives from one anchor — the first visit. Weekly and fortnightly repeat
on its weekday; monthly repeats on its *nth weekday of the month* ("the third
Tuesday"), because cleaning schedules are weekday-shaped and "the 31st" does not
exist half the year. See [`src/lib/recurring/schedule.ts`](src/lib/recurring/schedule.ts)
and [`docs/scheduled-work.md`](docs/scheduled-work.md).

Still unbuilt: a customer-facing view of their own schedule.

### Continuity, and answering an offer

Until `0015` the dispatch engine was a pure function called while drawing the admin
board: it decided who should get every job, built the ladder and priced each rung —
and then the request ended and all of it was discarded. `offers` had existed since
`0001` with nothing ever writing to it, so **nothing could be accepted**, and every
step after matching was unreachable.

Decisions and offers are now persisted, and answering one is a single database
operation. `respond_to_offer` locks the **job**, so two cleaners tapping Accept in
the same second produce one assignment and one honest "someone got there first" —
asserted against real Postgres alongside the other races. The payout written to the
assignment is read off the offer row and is deliberately not a parameter anywhere in
the path.

**The incumbent goes first.** A home with a cleaner is not re-auctioned. A W-2
incumbent is assigned; a contractor is offered the job *alone* for a window that
scales with the lead time available, and disappears entirely on a same-day backfill —
offered rather than assigned, because a platform that schedules a contractor without
asking is exercising the control that makes her an employee.

What continuity costs against the cheapest alternative is computed on every decision.
A revealed incumbency ("she has come the last six times") is subject to a cap; a
cleaner the customer explicitly **asked for** is not, at any price. The cap defaults
to 15% of the ticket and is a policy number to set, not a measurement — see
`MAX_CONTINUITY_PREMIUM_FRACTION` in
[`src/lib/dispatch/continuity.ts`](src/lib/dispatch/continuity.ts).

`dispatch_decisions.decided_by` is null when the engine decided and set when a person
did. That one nullable column is the whole numerator of *manager interventions per
100 completed cleans*, and it is there from the first decision recorded because it
cannot be backfilled.

Twilio, a live Supabase project and the Vercel deploy wait on the checklist in
[`docs/setup.md`](docs/setup.md) — **start the A2P 10DLC filing first**, carrier
approval takes one to three weeks and it gates everything customer-facing.
