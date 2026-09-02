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

## 3. Supabase

Create a project on the free tier, US-Central region. Then apply the migrations in
order:

```bash
supabase link --project-ref <ref>
supabase db push          # applies supabase/migrations/*.sql
```

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
