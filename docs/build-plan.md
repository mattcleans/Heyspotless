# Spotless Ops — build plan

The specification of record, from the "Spotless Ops Build Plan" artifact (Rev. 5,
27 Aug 2026). Kept in the repository so the code and its rationale travel together.

## The situation

Housecall Pro Max lists at $299/user/month, roughly $4,400/year in practice, against
a business that has run at an operating loss for 18 straight months. Killing that
line item is worth doing, but it is **not** the biggest prize:

| Lever | Worth per year |
|---|---|
| Lead conversion — marketing 33% → 15% | ~$24,000 |
| Iggy's phone hours — down to 30 min/day | ~$6,300 |
| Route density — paid windshield time | ~$5,900 |
| The HCP subscription | ~$2,700 |

The gig marketplace is worth almost nothing at current volume. It earns its keep only
past about 22 jobs a week — it is what lets the business *grow* without hiring
another salaried cleaner, not what fixes this quarter. It is still built in v1,
because retrofitting dispatch logic into a live system is genuinely painful.

**Lead conversion is v1 scope, not a phase-two nicety.** Marketing at ~33% of revenue
against a 15% target means leads are being bought and then lost.

## Architecture

Next.js (App Router), TypeScript, Tailwind, deployed to Vercel. Supabase provides
Postgres, auth, file storage for job photos, and realtime so the dispatch board
updates live. Row-level security means a cleaner physically cannot query another
cleaner's earnings — the rule lives in the database, not the UI.

Three front doors, one deployment, gated by role:

- **Admin** — dispatch board, calendar, customers and properties, price book, quotes
  and invoices, lead inbox, messaging, reporting, cleaner roster and applications.
- **Cleaner** (mobile-first) — job offers with countdown and payout, today's route,
  on-my-way, clock in/out with GPS stamp, room checklists, before/after photos,
  earnings.
- **Customer** — instant-quote booking widget, quote acceptance, reschedule and skip,
  invoice history, saved card, rate-your-clean.

The PWA layer makes it installable with an icon on iOS and Android. The offline job
cache matters more than it sounds: cleaners lose signal inside houses, and a
checklist that discards photos when the connection drops is one nobody uses twice.

### Why not Webflow Cloud

It would put the app at `heyspotless.com/app`, which is nicer for brand continuity,
but it runs on Cloudflare Workers with a 10 MB bundle ceiling, 128 MB of memory, a
20-second request timeout, partial Node support, and **no built-in scheduler**. The
reminder texts, auto-charges, recurring job generation and offer-escalation timers
all need a scheduler. A subdomain costs nothing in brand terms and removes every one
of those walls.

## The dispatch engine

This is the part that does not exist in Housecall Pro, Jobber, or ServiceTitan. The
objective is not "pay as little as possible" — it is **maximise utilisation of labour
already paid for, then buy the remainder as cheaply as possible without dropping
below a quality bar.**

Every job runs the same path:

**Step 1 — Shonda is a sunk cost until she is full.** At 40 guaranteed hours and
$17.50/hr she costs $805/week fully burdened whether she cleans fifteen houses or
four. The engine treats that block as pre-paid inventory and spends it before a
dollar reaches the marketplace.

> **Correction the plan makes to itself:** 15 jobs × 2.5 hours is 37.5 hours of
> cleaning, leaving 2.5 of the guaranteed 40 for every mile driven — ten minutes a
> job, which is not real in DFW. Fifteen jobs a week is a 43–45 hour schedule with
> 3–5 hours of overtime in it, costing $879–956 rather than $805. Still the cheapest
> labour available, but the app must show the overtime *before* the week is
> committed, not after payroll.

**Step 2 — the gate nobody crosses.** Rating below 3.9, background check not cleared,
insurance lapsed, outside the service zone, or already booked, and the cleaner simply
never sees the job. A database-level filter.

**Step 3 — the auction.** Scheduled work sits on an open board. Urgent work — under
72 hours, same-day, cancellation backfills — goes out as a timed waterfall, tier by
tier, with the payout stepping up until it crosses the cheapest W-2 option for that
job.

### Why a flat ceiling fails

| Shonda's marginal job | Cost | % of $170 ticket |
|---|---|---|
| Overtime, cleaning hours only | $75.47 | 44.4% |
| Overtime + 15 min paid drive | $83.02 | 48.8% |
| Overtime + 30 min paid drive | $90.56 | 53.3% — loses to a 50% marketplace job |

So the engine computes the **true marginal cost of every W-2 option for this specific
job** and escalates only until the market price crosses the cheapest of them.

Iggy reorders it again. At $21/hr she costs more per hour than Shonda's base but
never goes into overtime, and Shonda's 41st hour costs $26.25. Iggy's mileage is
reimbursed at the IRS rate (76¢ from 1 July 2026); Shonda drives the company truck
and is reimbursed nothing.

| Drive | Iggy total | Shonda on overtime |
|---|---|---|
| 10 min · 6 mi | $64.13 | $74.46 |
| 20 min · 12 mi | $72.71 | $79.49 |
| 30 min · 18 mi | $81.30 | $84.52 |
| 40 min · 24 mi | $89.89 | $89.56 — crossover |

So the order is **marketplace → Iggy → Shonda's overtime**, and past a 40-minute
drive it flips. That is why it is recomputed per job rather than held as a ranking.

### Offers are priced in dollars per hour

A flat 35% buys very different hourly rates, and it points the wrong way:

| Job | Price | Hours | 35% payout | Cleaner earns |
|---|---|---|---|---|
| Weekly 2bd/2ba | $160 | 2.30 | $56.00 | $24.35/hr — worst |
| Bi-weekly 2bd/2ba | $170 | 2.30 | $59.50 | $25.87/hr |
| Deep clean 3bd/2ba | $362 | 4.82 | $126.70 | $26.30/hr |
| Move-out 4bd/4ba | $576 | 8.05 | $201.60 | $25.04/hr |
| One-time std 3bd/2ba | $219 | 2.55 | $76.65 | $30.06/hr — best |

A 23% spread on an identical percentage, and the worst-paid jobs are the **weekly
recurring customers** — the most valuable relationships and the ones that must fill
every week. Under a flat 35% those are the offers cleaners skip, so they escalate,
and the premium lands exactly where margin is thinnest.

The ladder is therefore denominated in **$/hour**: it opens at $25/hr and climbs
toward $32/hr, capped by the cheapest W-2 option. The percentage floats per job — 29%
on a one-time 3/2, 36% on a weekly 2/2 — while take-home per hour stays flat, and the
offer reads *"$57.50 for about 2h20m"*, which is what a cleaner actually decides on.

This makes the duration estimate load-bearing, so the app recalibrates its per-room
minutes from real clocked time as jobs complete.

### The one real flaw, and four mitigations

A visible escalating ladder teaches cleaners to wait. If declining at the base rate
reliably produces more ten minutes later, every rational cleaner declines and average
payout drifts to the ceiling — the well-documented failure mode of ascending auctions
in labour marketplaces.

1. **Do not reveal the ladder.** Each offer is presented as *the* offer, with a
   countdown. No "this may increase" language, no visible history.
2. **Make declining cost something.** Acceptance rate is a ranking input. Volume is
   the reward for accepting at the base rate.
3. **Randomise the steps.** Size and timing vary per job within bounds.
4. **Watch the number.** Escalation rate is a first-class KPI. If more than ~30% of
   jobs clear above the base rate, the base rate is below market and the fix is a
   **higher opening rate**, not a higher ceiling.

### Route density is a feature, not a nicety

Because Shonda's 2.5 hours is cleaning only and her travel is paid, every mile
between houses bills at $17.50 — or $26.25 past forty hours.

| Avg drive | Total paid hrs | Overtime | Cost/wk | Cost/job | % of ticket |
|---|---|---|---|---|---|
| 10 min | 40.0 | 0.0 | $805.00 | $53.67 | 31.6% |
| 15 min | 41.25 | 1.25 | $842.73 | $56.18 | 33.0% |
| 20 min | 42.5 | 2.5 | $880.47 | $58.70 | 34.5% |
| 30 min | 45.0 | 5.0 | $955.94 | $63.73 | 37.5% |
| 45 min | 48.75 | 8.75 | $1,069.14 | $71.28 | 41.9% |

Tightening the average from 30 minutes to 15 saves **$5,887 a year** — more than
twice what cancelling Housecall Pro saves — from nothing but scheduling days as
geographic clusters instead of chronological lists.

It also exposes a structural advantage of the marketplace: **a contractor paid a flat
percentage absorbs their own windshield time.** That is a more durable edge than
winning the 35%-versus-44% argument.

> The 20-minute row above reads $878.96 / $58.60 / 34.5% in the original artifact.
> Its own stated inputs give $880.47; see `decisions.md`.

## Data model

Postgres with row-level security per role. The tables carrying the interesting logic:

| Table | Carries |
|---|---|
| `customers` · `properties` | Contact, billing, lifetime value, churn risk. Properties hold beds/baths, gate codes, pets, parking, access notes, supply location. |
| `price_book_items` · `price_book_rates` | The pricelist as structured data. Single source of truth for quoting. |
| `quotes` · `jobs` · `recurring_plans` | Quote → job → invoice lifecycle. Skips and reschedules are first-class, not deletions. |
| `cleaners` | Type, rating, acceptance rate, service zones, availability, insurance expiry, background-check status, guaranteed-hours terms. |
| `offers` | The auction ledger — every offer ever made. This is how the business learns what the market rate actually is. |
| `job_assignments` · `time_entries` | Clock in/out with GPS stamp, actual vs estimated duration — the input to real job costing. |
| `checklists` · `job_photos` · `ratings` | Per-room completion, before/after photos, the rating that feeds back into dispatch eligibility. |
| `invoices` · `payments` · `payouts` | Stripe objects mirrored locally so reporting never depends on an API call. |
| `leads` · `messages` · `automations` | Unified lead inbox, full SMS and email threads, the event-driven automation log. |
| `applications` | The recruiting funnel. Nobody reaches `cleaners` without clearing it. |

Reporting reads these directly rather than through a sync, which is how you get job
costing that Housecall Pro famously does not do: revenue minus actual labour minus
travel, per job, per cleaner, per customer, per channel.

## Build order

| # | Phase | Scope |
|---|---|---|
| 00 | Accounts and keys | `docs/setup.md`. Gates everything. |
| 01 | Foundation | Repo, scaffold, schema, RLS, auth, design system, PWA shell, deploy. **Built.** |
| 02 | Core operations | Customers, properties, price book, jobs, calendar, recurring plans. **Price book and quoting built.** |
| 03 | Money | Quote builder, Stripe Checkout, saved cards, auto-charge, tips, refunds. **Built.** Live behind `BILLING_ENABLED` until underwriting clears. |
| 04 | Cleaner app | Today's schedule, on-my-way, clock in/out, checklists, offline photo queue, push. |
| 05 | Dispatch engine | Marginal cost, clustering, overtime forecast, gate, tiers, board, waterfall, offer ledger. **Built.** |
| 06 | Communications | Twilio two-way inbox, reminders, review requests, automation engine. |
| 07 | Growth | Booking widget, lead inbox, nudge sequence, at-risk detection, job costing. |
| 08 | Recruiting funnel | Apply page, AI screen, documents, background check, activation. Launch-critical — the auction needs supply. |
| 09 | Migration | Import HCP data, verify, 30–60 day parallel run. |
| 10 | Store wrapper | Capacitor, native push, App Store and Play submission. |

## Risks

- **You may be overcharging live recurring customers.** The pricing forms list
  Monthly, Bi-weekly and Weekly at $0.00, with the discount applied manually after
  booking, and at least one live monthly client is paying the full one-time rate.
  This is a churn and trust problem, it is happening right now, and it is more urgent
  than anything else in this document.
- **Locked-in legacy rates.** The 9 August increase applies to new customers only.
  Migration must carry old rates across or the first regenerated quote silently
  raises every long-standing customer's price. `recurring_plans.price_locked` exists
  for this.
- **Worker classification** — the highest legal exposure. See `setup.md`.
- **The cold start** — an auction with four cleaners is not an auction.
- **HCP will not export everything** — no documented export for estimates, invoices,
  or recurring plans.
- **You become your own support desk.** This is the main thing being bought with that
  $2,748.
