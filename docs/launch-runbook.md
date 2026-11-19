# Launch runbook

The ordered path from here to real customers. Everything in this file is
either **done and verified**, or an **operator task** — something only Matt
or Maddie can do, because it needs an account, a signature, a decision, or a
phone in a hand. The engineering detail behind each step lives in
[`setup.md`](setup.md) and [`release-readiness.md`](release-readiness.md);
this file is the order to do them in and what each unblocks.

`GET /api/health` with the cron secret answers, at any moment, which of
these are actually wired. Trust it over memory.

## Where engineering stands (verified 16 November 2026, this branch)

| Check | Result |
|---|---|
| Unit suites (pricing, dispatch, billing) in UTC **and** America/Chicago | Pass |
| Typecheck (strict), lint, production build | Pass |
| All migrations + SQL invariants against real PostgreSQL (`verify-migrations.sh`) | Pass |
| Deploy at `app.heyspotless.com`, auth, hourly sweeps | Live and green |
| Official brand system (colors, type, icon) applied app-wide | Done |
| Oversight metrics (interventions / 100 cleans, escalated pairings) | On `/admin/reporting` |

A green sweep against a near-empty database proves the machinery, not the
business. The rows arrive in phase C below.

## Phase A — accounts and wiring (about half a day, no customer impact)

Everything here is reversible and touches no customer. Do it in one sitting.

1. **Custom SMTP** in Supabase (Resend free tier works) — without it,
   sign-in emails are capped at two per hour and only reach team addresses.
   This silently blocks every other acceptance test, so it goes first.
   Steps: `setup.md` § Custom SMTP.
2. **Stripe account** under Hey Spotless LLC.
   Publishable + secret keys into Vercel, webhook endpoint with the eight
   events, signing secret into `STRIPE_WEBHOOK_SECRET`. Leave
   `BILLING_ENABLED=0`. Steps: `setup.md` § 2.
3. **Twilio** — the campaign is approved; this is wiring. Three variables
   into Vercel, point the messaging service's inbound webhook at
   `/api/twilio/inbound`, leave Advanced Opt-Out on. Keep
   `MESSAGING_ENABLED=0` until phase C is done. Steps: `setup.md` § 1.
4. **Web Push** — `npm run push:keys` once, three VAPID variables into
   Vercel. Steps: `setup.md` § 11.
5. **Matching worker** — deploy the Supabase worker so matching retries
   every five minutes instead of daily; verify on `/admin/automation`.
   Steps: `matching-worker.md`.

## Phase B — Stripe, end to end

The one open billing gate: no card, webhook or auto-charge has ever run
against Stripe itself. Chosen path (18 November 2026): verify in **live
mode** with a $1 invoice on the test customer, paid with a real card and
then refunded. The cost is the Stripe fee on $1, which a refund does not
return.

**Done 19 November 2026**: Checkout, a Stripe-dashboard refund, and a
refund from Management's own form (customer page → Payments → Refund).
See `release-readiness.md`, Integrated verification.

Before the pilot, in Stripe → Settings → Payment methods, keep cards,
Apple Pay / Google Pay and Link, and turn off bank payments and Amazon
Pay. A bank payment settles days later, and until then the client's
account page reads as an unconfirmed payment.

- Pay the $1 invoice through Checkout; watch the webhook settle it to paid
  with exactly one payment row.
- Refund it from Management; watch `refund.updated` move it out of pending.
- Auto-charge stays off (`AUTOCHARGE_ENABLED=0`) for the pilot. Its
  off-session failure path (`4000 0000 0000 0341`) needs test mode and is
  deferred until autopay is offered.

### Switching modes: three keys, one redeploy, and stale ids

Stripe keeps test and live as two separate worlds. Each switch is:

1. Swap `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY` **and**
   `STRIPE_WEBHOOK_SECRET` in Vercel. The webhook endpoint exists once per
   mode, each with its own signing secret. Swapping only the API keys means
   every webhook fails its signature check.
2. Redeploy. Environment changes never reach a running deployment.
3. Clear stored Stripe references made in the other mode:
   `customers.stripe_customer_id` and active `payment_methods` rows. A
   customer or card id from one mode is unknown in the other, and Checkout
   fails with "Stripe refused Checkout creation" until they are cleared.
4. Resolve any payment attempt still open from the other mode. The app
   cannot see the other mode's sessions, so it holds the invoice blocked
   ("Your previous payment request could not be confirmed"). Switch the
   keys back long enough to use **Check payment status** on
   `/admin/payments`, or confirm in that mode's Stripe dashboard that no
   charge exists and use **Release request**.

## Phase C — the Housecall Pro import

`MESSAGING_ENABLED=0` stays set throughout. Export customers, jobs and the
price book from HCP; dry-run the import until its report is clean; add a
plans file for any cadence it cannot infer; run it for real. Then run the
**price audit** (`recurring_price_audit`) — the overbilling check is
time-sensitive and every mismatched row is a conversation with a customer,
not a script. Decide per plan whether this app or HCP owns upcoming visits.
Steps: `setup.md` §§ 6–7.

## Phase D — people acceptance, on real devices

- Provision one admin, one cleaner, one customer account; sign each in on
  the device they will really use.
- Send a real SMS to a real handset; reply to it; reply STOP; confirm the
  inbox saw all three.
- Run one whole clean on an iPhone and an Android: accept the offer,
  arrive, photograph rooms (including with airplane mode mid-upload),
  mark done, rate from the text link.
- Each cleaner reviews and consents to her public profile
  (`cleaner-profiles.md`) before activation.

## Phase E — decisions only the business can make

- **Approve the money-policy worked examples** (`money-policy.md`) —
  billing stays off until this is signed off.
- **Worker classification opinion** from a CPA or employment attorney,
  Texas-specific, before the first 1099 contractor is activated. The
  single biggest legal exposure in the plan (`setup.md` § 9).
- **Contractor insurance** — their policy or yours; either way it becomes
  a hard onboarding gate.
- **Drive-time questions** (`setup.md` § 8) — FLSA exposure worth real
  money either way.
- **Rotate the exposed HCP API token** (`setup.md` § 10).
- **Approve the December pilot**: cohort, transition register, staffed
  coverage (`december-pilot-operations.md`).

## Phase F — go live

- `MESSAGING_ENABLED=1` only after phase C and the handset test.
- Pilot week per `december-pilot-operations.md`; HCP stays read-only as
  the archive of record.
- Watch, weekly, on `/admin/reporting`: interventions per 100 cleans,
  escalated pairings, time-to-fill on **new** recurring customers (the
  known worst-paying board jobs — `MINIMUM_PAYOUT_CENTS` is the lever if
  they sit).

## App stores

The installed PWA is the day-one app on both platforms — booking,
schedule, photos, push notifications, home-screen icon. Store listings
are procurement, not engineering: an Apple developer account ($99/yr), a
Play account ($25), Capacitor wrappers, signing, and review queues
measured in days. Do it when a store listing would answer something the
home-screen icon cannot — most usefully after the pilot proves the flows
the reviewers will click through.
