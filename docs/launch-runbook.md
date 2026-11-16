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

## Phase B — Stripe test mode, end to end

The one open billing gate: no card, webhook or auto-charge has ever run
against Stripe itself. In **test mode**, before any live key:

- Checkout with `4242 4242 4242 4242`; watch the webhook settle the invoice.
- Save `4000 0000 0000 0341`, let auto-charge fail off-session, watch the
  retry schedule hold (1 / 3 / 7 days).
- Issue a refund; watch `refund.updated` move it out of pending.

When all three behave, and the money-policy worked examples are approved
(phase E), switch to live keys and `BILLING_ENABLED=1`.

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
