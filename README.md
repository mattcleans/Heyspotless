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
src/lib/messaging/    Twilio boundary — quiet hours, message bodies, send log
src/lib/service/      finishing a job — rooms, photo evidence, the invoice gate
src/lib/stripe/       SDK boundary — client, config flags, cron guard
src/app/admin/        dispatch board, quote builder, price book, inbox, leads,
                      applications, reporting
src/app/api/          Stripe webhook, checkout, saved cards, auto-charge sweep,
                      refunds, recurring generation, offer accept/decline,
                      dispatch sweep, job start/complete/photo/on-my-way,
                      Twilio inbound, automation sweep, ratings, leads,
                      applications, health
src/app/cleaner/      cleaner PWA — today's route, answering an offer, and
                      running a job: arrive, photograph each room, mark done
src/lib/offline/      the photo queue — durable before sent, never discarded
src/app/customer/     customer portal — balances, saved card, autopay
src/app/rate/         rate-your-clean, opened from a text, no sign-in
src/app/book/         the public booking widget — a price before a form
src/app/apply/        the public application form — the pay before the questions
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

Phases 1–8 of the build plan are built, and the app is deployed at
`app.heyspotless.com` against a live Supabase project, with the recurring,
dispatch and automation sweeps running green against it.

**Billing is the exception and it is not a small one.** Checkout, saved cards,
auto-charge, tips and refunds are written and tested against real Postgres, and
switched off in production: the Stripe webhook currently answers
`503 billing is not enabled`. It turns on when `STRIPE_SECRET_KEY` is set and
`BILLING_ENABLED=0` is not holding it. Until then the customer screen shows real
balances and says plainly that payments are not live, rather than offering a
button that fails. **No Stripe flow has been exercised end to end against
Stripe's own test mode** — see `docs/release-readiness.md`.

What this deployment actually has wired, in booleans and row counts and no
secrets:

```bash
curl -s https://app.heyspotless.com/api/health -H "x-cron-secret: $CRON_SECRET" | jq
```

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

**Continuity is not given up on price.** A cleaner who has been to a house before
keeps going to that house. What ends it is a reason — the customer asks for somebody
else, the customer complains, she stops clearing the eligibility gate, or she turns
the visit down. `property_cleaner_blocks` (`0017`) is where the first two live, per
property and as a row with a reason, so "why did Marisol stop coming in March" has an
answer a year later.

The cost of that choice is still computed and recorded on every decision. It reassigns
nobody; it is there to be read. A cost ceiling survives as a manual safety valve and is
**off by default** — see `MAX_CONTINUITY_PREMIUM_FRACTION` in
[`src/lib/dispatch/continuity.ts`](src/lib/dispatch/continuity.ts).

### What a clean pays

**33% of whatever the customer pays** (`0018`), escalating to a ceiling of 49% if
nobody takes it. A discount to the customer reduces the cleaner's fee in proportion,
because the two are the same number scaled. The ceiling that usually binds is not 49%
but the cheapest W-2 option for the specific job — past it, sending our own employee
is cheaper than buying the labour.

This replaced a dollars-per-hour ladder. Paying a rate times *our* estimate made her
fee a function of our guess — estimate a job at 173 minutes and if it takes 240 we
have underpaid her by the size of our own error — and paying by the hour is an
employment marker, which matters given worker classification is the largest legal
exposure in the plan.

It also fixes the spread for free. `agreed_price_cents` locks what a recurring
customer pays for the life of the plan, and a constant share of a locked price is a
locked payout. `agreed_payout_share` exists only to record a *negotiated* exception,
and is almost always null.

The known cost is written down in `docs/build-plan.md` and asserted in
`ladder.test.ts`: a flat share pays worst on the discounted jobs, which are the
recurring ones. That is survivable because a recurring visit goes to its incumbent
exclusively rather than onto a board — but a **new** recurring customer has no
incumbent and is the worst-paying job on that board. `MINIMUM_PAYOUT_CENTS` is the
lever if new weeklies are slow to fill. It is off.

`dispatch_decisions.decided_by` is null when the engine decided and set when a person
did. That one nullable column is the whole numerator of *manager interventions per
100 completed cleans*, and it is there from the first decision recorded because it
cannot be backfilled.

### Talking, and listening

Phase 06. Until `0022` the platform could only talk: a cleaner who replied STOP
was opted out at the carrier and nowhere else, so dispatch went on writing her
offers she could not see and counting each expiry against the acceptance rate
that decides what work she is shown. A customer replying "can we move Tuesday"
was received by Twilio and discarded.

Inbound messages are now verified against Twilio's signature, recorded BEFORE
they are interpreted — evidence kept only when it was understood is evidence
that goes missing exactly when it matters — and attached to whoever the number
belongs to. STOP is honoured by **number**, not by role: one handset, one
request, so the cleaner who is also a customer is opted out of both.

What the business says on a schedule — the booking confirmation, the evening-
before reminder, the review request — is **derived from the schedule rather than
hooked to the booking path**. Nothing writes a reminder when a job is created,
because that is the design that quietly loses them: a visit generated at 2am, or
moved by a form that has never heard of reminders, or imported from Housecall
Pro. The sweep asks what the next fortnight implies, keyed so that asking twice
produces one row, and a visit that moves takes its unfired reminder with it.

The rating that comes back is not a vanity metric: `record_rating` recomputes
the cleaner's standing on the column the eligibility gate reads, so a cleaner
who drops below the 3.9 floor stops being offered work on the next sweep rather
than the next morning.

### The leak

Phase 07, and the largest single lever in the build plan: marketing at ~33% of
revenue against a 15% target is about **$24,000 a year**, more than the next
three levers combined. What loses those leads is not price, it is silence.

`/book` is public, outside every gated area, and answers the question the
customer actually asked — the price, from the same `buildQuote` the office and
the recurring generator use, before any form. Pressing the button writes a lead
with that price on it and texts an acknowledgement **inline**, not through the
sweep: an acknowledgement that waits an hour for the next cron run is not one.

The chase is then a queue rather than somebody's memory — three texts over three
days, and it stops the moment a person replies, the lead is won or lost, or
consent is absent. `first_response_at` measures the human answer only; the
automated acknowledgement deliberately does not set it, because a KPI a robot
can satisfy is not a KPI.

Two views carry the numbers Housecall Pro famously does not compute:
`job_costing` (revenue minus the labour actually spent minus the mileage, per
**job** — a contractor costs her payout, a W-2 costs hours × rate × burden
including the drive) and `customer_at_risk` (days since the last clean against
the cadence the customer agreed to, with anything already booked excluded).
Both are locked twice: no SELECT for client roles, and `security_invoker` so the
policies still apply if a future migration grants them back. The verification
suite asserts the second lock **after** deliberately granting the first away.

### Supply, and the funnel that led nowhere

Phase 08. The build plan calls the recruiting funnel launch-critical, and the
reason is not staffing in the ordinary sense: **an auction with four cleaners is
not an auction.** Every mechanism in the dispatch engine assumes somebody else
might take the job.

Building it surfaced a defect that would have made the whole phase pointless.
The eligibility gate in `0003` reads `coalesce(c.rating, 0) >= 3.9`, so a
cleaner with no rating is ineligible for everything — and a brand-new cleaner
has no rating by definition. Every cleaner hired through this funnel would have
been activated, appeared on the roster, and never been offered a single job,
silently, because "no eligible cleaner" looks exactly like a quiet week.
`lib/dispatch/eligibility.ts` has promised since it was written that "new
cleaners are seeded with a provisional rating during onboarding". Nothing ever
did it, because onboarding did not exist. `activate_cleaner` now does, and the
verification suite asserts a freshly activated cleaner is eligible against the
real gate rather than against the number.

The rating maths changed with it. `0022` set a cleaner's standing to the plain
average of her reviews, which meant one three-star — from one customer, on one
clean, in her first week — put her under the floor and ended her career on the
platform. A floor a single data point can trigger is a lottery, not a quality
bar. Ratings are now averaged against a prior worth five reviews at 4.2, so one
three-star marks her down to 4.0 and nine of them cross the floor.

Still on the checklist in [`docs/setup.md`](docs/setup.md): Stripe, the customer
book, and the three things nobody else can do — the overbilling audit, the
worker-classification opinion, and rotating the exposed HCP token.
