# Setup checklist

About an hour of your time in total. **Do item 1 first** — it is the one with a
multi-week clock on it, and everything customer-facing waits behind it.

Never paste a secret key into a chat, an issue, or a pull request. Put it straight
into `.env.local` (git-ignored) or the Vercel environment settings.

## 1. Start the Twilio A2P 10DLC filing — do this today

Create a Twilio account, register the business brand, and submit a messaging
campaign. **Carrier approval takes one to three weeks.** Confirmations, reminders,
on-my-way texts and review requests all wait on it; email and push cover the gap.

Needed: account SID, auth token, and a decision on whether to port the current
business number.

## 2. Stripe

Create an account for Hey Spotless LLC and complete business verification. Enable
Stripe Connect if the app should handle 1099 payouts. Underwriting usually clears in
a day and blocks only card-on-file and auto-charge.

Needed: publishable key + secret key. Test mode is fine to start.

The billing code is built and tested; it is switched off until you set
`STRIPE_SECRET_KEY`, and `BILLING_ENABLED=0` keeps it off even with keys present.
Until then the customer screen shows real balances and says plainly that payments
are not live, rather than offering a button that fails.

**Add the webhook before taking a single payment.** Nothing settles an invoice
except the webhook — a customer closing the tab on the Stripe page must not leave
an invoice marked paid that never was.

1. Dashboard → Developers → Webhooks → *Add endpoint*, pointing at
   `https://app.heyspotless.com/api/stripe/webhook`.
2. Subscribe to exactly these events:
   `checkout.session.completed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_method.attached`,
   `payment_method.detached`, `charge.refunded`,
   `refund.updated`, `refund.failed`.
   Anything else is answered with "ignored" rather than an error, so a stray
   event will not cause a retry storm — but there is no reason to send one.

   **The last two are not optional.** A refund can be accepted by Stripe and
   rejected by the issuer days later. Refunds we are not yet sure of are
   recorded `pending` and move no money until one of those events settles them
   (see `docs/money-policy.md`). Without them subscribed, a pending refund sits
   pending for ever: the customer has their money back and the invoice never
   records it. Older accounts send this as `charge.refund.updated`, which is
   handled identically — subscribe to whichever your dashboard offers.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Locally, `stripe listen --forward-to localhost:3000/api/stripe/webhook` prints a
signing secret to use instead.

Test the money paths in test mode before going live: card `4242 4242 4242 4242`
succeeds, `4000 0000 0000 0341` attaches fine and then fails when charged
off-session, which is the case auto-charge retries actually have to survive.

## 2a. Auto-charge

Auto-charge is opt-in per customer and needs two things that are deliberately
separate: a saved card, and recorded consent. A card on file is not permission to
charge it — the database refuses a customer marked `autopay_enabled` with no
`autopay_authorized_at` timestamp, because that timestamp is the evidence if a
charge is ever disputed.

The sweep runs at `POST /api/billing/autocharge`, guarded by `CRON_SECRET` rather
than a session because it runs with no user. Generate one with
`openssl rand -hex 32`. Unset, the endpoint refuses everything.

Four attempts, spread 1 / 3 / 7 days, then it stops and leaves the invoice for a
person. Scheduling it is phase 04 (`vercel.json`); until then it can be run by
hand:

```bash
curl -X POST https://app.heyspotless.com/api/billing/autocharge \
  -H "x-cron-secret: $CRON_SECRET"
```

## 3. Supabase

Create a project on the free tier, US-Central region. Then apply the migrations in
order:

```bash
supabase link --project-ref <ref>
supabase db push                                  # applies supabase/migrations/*.sql
psql "$DATABASE_URL" -f supabase/seed.sql         # optional starter data
```

Migrations `0004` and `0005` bind `profiles` to `auth.users` and add the
`cleaner_week_load` view that dispatch reads. Enable **Email** as a sign-in
provider in Authentication → Providers; the app uses magic links, so no password
policy is needed. Add `https://app.heyspotless.com/auth/callback` (and
`http://localhost:3000/auth/callback` for local work) to the allowed redirect
URLs.

Needed: project URL, anon key, service role key. The service role key bypasses
row-level security — server-side only, never in the browser.

## 4. Vercel

Create an account and connect it to GitHub. Set the environment variables from
`.env.example` and remove `DEMO_MODE`.

## 5. DNS

Add a `CNAME` for `app.heyspotless.com` pointing at Vercel. The Webflow marketing
site is untouched.

## 6. Export from Housecall Pro

Customers → Actions → Export, and Jobs → Actions → Export. Both arrive by email
within the hour. Export the price book separately. You must be logged in as an Admin.

There is no documented export for estimates, invoices, or recurring service plans —
those get reconstructed from the CSVs and whatever the API exposes, and HCP stays
read-only as the archive of record for a few months rather than pretending the
migration was lossless.

## 7. Audit live recurring jobs for the missing discount — time-sensitive

The pricelist flags at least one monthly client paying the full one-time rate. Check
every active recurring job against the plan the customer agreed to and decide how to
handle any that were overbilled.

The new schema stores the agreed rate on `recurring_plans.agreed_price_cents` with a
`price_locked` flag, so it cannot recur — but that fixes the future, not invoices
already sent. **This is happening right now**, which makes it more urgent than
anything else here.

## 8. Questions that change the model

- **Is Iggy's between-job drive time on the clock**, not just her mileage? Under the
  FLSA both are owed to non-exempt employees, and you can owe both. Modeled as paid.
  Worth about $6,279/yr at fifteen jobs a week.
- **Is Shonda paid for drive time today?** Same rule. If it is not on her timesheet
  now, that is worth fixing independently of this project.
- **Iggy's cleaning hours per week, and whether she has room for more.** Her spare
  capacity is what holds the auction ceiling near 40% instead of 50%. If cleaning
  fills her up, that lever disappears.
- **Shonda's actual average drive between jobs.** The gap between 15 and 30 minutes
  is $5,887 a year. A week of her real route from HCP would settle it exactly.
- **The company vehicle's real all-in cost** — payment, commercial insurance, fuel,
  maintenance. Modeled at $1,000/month.

## 9. Get professional opinions

- **Worker classification.** A 1099 pool where you set the price, specify the method,
  and rate the work carries real reclassification exposure with both the IRS and the
  Texas Workforce Commission. Ask your CPA specifically whether a contractor who
  freely accepts or declines company-priced jobs, using company-specified methods,
  holds up in Texas. The schema supports either structure, but get an opinion before
  activating the first contractor. This is the single biggest legal exposure in the
  plan.
- **Contractor insurance.** Decide whether 1099 cleaners must carry their own general
  liability and be bonded, or work under your policy. Either way it becomes a hard
  gate in onboarding.

## 10. Rotate the exposed Housecall Pro API token

The `web-lead-response` skill file contains a live HCP API token in plaintext. Rotate
it in Housecall Pro and replace it in the skill with an environment variable
reference. It is not in this repository and must not be added to it.
