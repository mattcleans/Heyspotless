# Decisions

Settled architecture from section 02 of the build plan, plus every place this
implementation deliberately departs from the document.

## Locked decisions

| Area | Decision | Consequence |
|---|---|---|
| Delivery | PWA now, App Store / Play wrapper later | One codebase. Installable day one; store listing is phase 10. |
| Hosting | Vercel at `app.heyspotless.com` | Webflow marketing site untouched. Full Node runtime, built-in cron for reminders. |
| Database | Supabase (Postgres, auth, storage, realtime) | Data in standard SQL. Free tier covers current volume. |
| Payments | Stripe — card on file, auto-charge, tips | Recurring cleans bill themselves. Connect handles 1099 payouts. |
| Texting | Twilio + A2P 10DLC, two-way inbox | Confirmations, reminders, on-my-way, review requests. |
| Workforce | Hybrid — W-2 core + vetted 1099 overflow pool | Two cleaner types, two pay rules, two onboarding gates. Needs CPA sign-off. |
| Dispatch | Timed waterfall for urgent, open board for scheduled | The centrepiece. |
| Payout band | Opens at $25/hr, escalates against the cheapest W-2 **marginal cost for that specific job** | Not a flat ceiling. Sometimes 44%, sometimes 53%. |
| Quality floor | 3.9 / 5.0 minimum to receive any offer | Below the floor a cleaner sees no jobs. Enforced in the database. |
| Shonda | 40 gtd hrs @ $17.50, 1.5× OT, 2.5 hrs per job **plus paid drive**, company vehicle | Target 15 jobs/wk is an overtime schedule, not a 40-hour one. |
| Iggy | Part-time @ $21/hr, mileage reimbursed at the IRS rate | Cheaper than Shonda's overtime up to about a 40-minute drive. |
| Migration | Full history, parallel run 30–60 days | HCP stays authoritative until a billing cycle runs clean. |

## Departures from the plan

### Next.js 16, not 15

The plan specifies Next.js 15; 16.3.4 is current. Confirmed with Matt. Same App
Router architecture — nothing in the design depends on 15, and starting on 15 would
mean a major upgrade shortly.

### Offers are priced per hour, not as a percentage

Already the plan's own conclusion, restated here because it is the single most
load-bearing decision in `lib/dispatch/ladder.ts`. A flat 35% produces a **23%
spread** in what a cleaner actually earns per hour, and it points the wrong way: the
worst-paid jobs are the weekly recurring customers, the ones that most need to fill.
Both facts are asserted in `ladder.test.ts`.

### Exact integer arithmetic, and two errors in the source documents

Wage maths is done in scaled integers and rounded once, half up. This is not
fussiness — it surfaced two real defects:

**1. Three §04 rows land on an exact half cent.** A 2.3-hour job plus a 40-minute
drive at $21/hr with a 15% burden is exactly 7164.5 cents. The plan rounds that row
**up** to $71.65 but rounds 6359.5 **down** to $63.59 and 8452.5 **down** to $84.52 —
the signature of floating-point error in whatever produced the document.
Accumulating `hours * rate * 1.15` in floats reproduces the error; scaling to
integers does not. The tests allow ±1¢ against the published figures and assert the
rounding rule explicitly.

**2. The §05 20-minute row is arithmetically wrong.** It prints **$878.96**, but its
own stated inputs — 40 guaranteed hours plus 2.5 overtime hours — give **$880.47**.
The other four rows of that table match the same formula to the cent, so the formula
is right and that one cell is wrong. `route.test.ts` asserts the correct figure and
records the discrepancy rather than reproducing it.

Neither changes any conclusion in the plan. Both are worth knowing before these
numbers reach a payroll conversation.

### Three fixes to migration 0002

Matt's `0002_price_book.sql` was adopted nearly verbatim. Each fix is marked inline
with `FIX (0002 review)`:

1. `mileage_rates.cents_per_mile` was `integer`, but the H1-2026 IRS rate is **72.5
   cents**. `72.5::integer` rounds to 73 and silently overpays every mile of the first
   half of the year. Now `numeric(5,2)`.
2. A dead `for v_id in select null::uuid loop end loop;` no-op was removed.
3. `quote_price()` returned `(0, 0)` for a service/frequency pair that does not exist
   — Deep is one-time/monthly only, Move In/Out is one-time only. A silent **$0
   quote** to a real customer is worse than an error, so it now raises. The
   TypeScript `buildQuote` throws `PriceBookError` for the same case.

### The board plans as a batch

`dispatch()` decides one job. Using it per-job on a board is wrong in a way that is
easy to miss: every job is told the same guaranteed hours are free, so six jobs each
claim the same 8.5 unspent hours and the schedule over-commits. `dispatchBoard()`
allocates soonest-first and consumes capacity as it goes.

### An unrated cleaner is ineligible

The plan specifies a 3.9 floor but not what to do with a null rating. New cleaners
get a provisional rating during onboarding, so a null here is a data problem — and
the safe reading of a data problem is ineligible, not "above the floor by default".

## Enforced in the database, not the UI

Two rules live in Postgres because a UI bug must not be able to route around them:

- **Earnings isolation.** Row-level security means a cleaner physically cannot query
  another cleaner's payouts or offers. It also keeps the auction ladder invisible.
- **The eligibility gate.** `cleaner_is_eligible()` is a `CHECK` constraint on the
  `offers` table, so an offer to someone who has not cleared a background check
  cannot be written at all — not by the engine, not by a manual override, not by an
  admin running SQL directly.

The TypeScript in `lib/dispatch/eligibility.ts` mirrors the SQL so the UI can explain
*why* someone is ineligible without a round trip. The database remains the authority.

## Known risks

- **Cold start.** Below roughly ten active vetted cleaners the waterfall is just
  sequential phone calls with a nicer interface, and the opening rate will not clear.
  Recruiting supply is the bottleneck, not software.
- **Auction gaming.** A visible escalating ladder teaches cleaners to wait. Four
  mitigations are built in — the ladder is never revealed, acceptance rate feeds tier
  ranking, steps are randomised, and escalation rate is a first-class KPI — but they
  are unproven at this scale.
- **Worker classification.** See `setup.md` item 9.
- **You become your own support desk.** The mitigations are the parallel run, boring
  well-documented technology, and data in standard Postgres you can export at any
  moment.
