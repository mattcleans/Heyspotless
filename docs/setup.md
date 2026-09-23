# Setup checklist

About an hour of your time in total. Items 1 and 3–5 are done: the A2P campaign
cleared on 14 September 2026, the Supabase project is live, and the app is
deployed at `app.heyspotless.com` with the hourly sweeps running green against
it. What remains is Stripe (item 2 — billing is switched OFF in production
today), the customer book (item 6), and the items nobody can do for you: 7, 9
and 10.

`GET /api/health` with the cron secret answers which of these are actually
wired, without anybody having to guess:

```bash
curl -s https://app.heyspotless.com/api/health -H "x-cron-secret: $CRON_SECRET" | jq
```

Never paste a secret key into a chat, an issue, or a pull request. Put it straight
into `.env.local` (git-ignored) or the Vercel environment settings.

## 1. Twilio — A2P 10DLC ✅ approved 14 September 2026

Done. The brand registration is **BLISS CLEANS LLC** and the customer-facing
campaign brand is **Hey Spotless** — the same company, and the reason there is
no second LLC named after the brand.

What is left is wiring, not waiting:

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
   `TWILIO_MESSAGING_SERVICE_SID` in Vercel. The **messaging service**, not a
   bare number: the campaign is registered against the service, and traffic
   sent from a number outside it is what carriers filter.
2. **Point the messaging service at the inbound webhook.** Twilio console →
   Messaging → Services → your service → Integration → *Send a webhook*, with

   ```
   https://app.heyspotless.com/api/twilio/inbound      (HTTP POST)
   ```

   Without this the platform can talk and cannot listen: a cleaner who replies
   STOP stays opted out at the carrier and reachable in our database — so
   dispatch goes on writing her offers she never sees, and every expiry counts
   against the acceptance rate that decides what work she is shown. A customer
   replying "can we move Tuesday" is received by Twilio and discarded.

   The endpoint verifies Twilio's signature and refuses anything else, so it is
   safe to have live before the number is in use. It signs against
   `NEXT_PUBLIC_APP_URL` — if that is unset or wrong, every real delivery fails
   the check.
3. Leave **Advanced Opt-Out** on in the messaging service. It answers STOP,
   START and HELP at the carrier level; the webhook records the same events so
   the marketplace stops offering work to somebody who cannot see it.
4. `MESSAGING_ENABLED=0` holds all sending off even with keys present — worth
   setting while the customer book is still being imported, so a migration
   cannot text several hundred people at once.

Needed if the current business number is to be ported: that decision, which is
independent of everything above.

## 2. Stripe

Create a Stripe account under **BLISS CLEANS LLC** (doing business as Hey Spotless)
and complete business verification. The customer-facing statement descriptor is
**HEY SPOTLESS** — that is what prints on a card, so it is the brand, not Bliss
and not a second LLC. Enable Stripe Connect if the app should handle 1099 payouts.
Underwriting usually clears in a day and blocks only card-on-file and auto-charge.

Needed: publishable key + secret key. Test mode is fine to start.

**Not done yet, and it is the last thing between here and taking money.** As of
17 September 2026 production answers the Stripe webhook with
`503 billing is not enabled`, which means either `STRIPE_SECRET_KEY` is unset in
Vercel or `BILLING_ENABLED=0` is holding it. `/api/health` says which.

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

## 6. Export from Housecall Pro, then import

Customers → Actions → Export, and Jobs → Actions → Export. Both arrive by email
within the hour. Export the price book separately. You must be logged in as an Admin.

There is no documented export for estimates, invoices, or recurring service plans —
those get reconstructed from the CSVs and whatever the API exposes, and HCP stays
read-only as the archive of record for a few months rather than pretending the
migration was lossless.

### Running the import

**Set `MESSAGING_ENABLED=0` in Vercel first.** The automation planner already
refuses to confirm old bookings and refuses to ask for a review of a clean that
was imported after it happened — both are tested — but the cost of being wrong
is texting several hundred people at once, and a flag costs nothing.

Then, from a laptop, with the service-role key in the environment and never in
CI:

```bash
export NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...

# Always first. Reads everything, writes nothing, and prints every row it
# could not understand — which is the interesting output of a migration.
npm run import:hcp -- --customers customers.csv --jobs jobs.csv --dry-run

npm run import:hcp -- --customers customers.csv --jobs jobs.csv
```

Both files in one run: jobs reference customers by their Housecall Pro id, and
the dry run's most useful output is the list of jobs whose customer is not in
the customer export.

It is safe to run again. Every import keys on the Housecall Pro id, so a second
run updates what the first wrote — and a room count somebody has since verified
on site, or a note typed in this app, survives a re-run.

### Then check the price audit — this is item 7

```sql
select first_name, last_name, freq, agreed_price_cents, book_price_cents,
       verdict, paying_one_time_rate
from recurring_price_audit
where verdict <> 'matches'
order by paying_one_time_rate desc, difference_cents desc;
```

`paying_one_time_rate` is the exact shape item 7 describes: a recurring customer
being charged the one-time price because the frequency discount was meant to be
applied by hand after booking and nobody did. The audit corrects nothing —
every row is a conversation with a customer, and a migration that silently
re-priced them would be the fault it exists to detect.

Every imported plan is `price_locked`, so the 9 August increase cannot reach a
legacy customer through a regenerated quote.

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


## 11. Web Push — optional, and the cheapest thing on this page

Notifications reach a cleaner in seconds; a text sits in a thread alongside
every other text she gets. An offer rung lives 8 to 15 minutes, so that
difference is the difference between the ladder working and the ladder running
to its ceiling. Push also costs nothing per send, while every rung that goes to
a tier costs money in SMS.

```bash
npm run push:keys      # once. Rotating invalidates every subscription.
```

Put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel. The
private key belongs there and nowhere else — not in the repo, not in a chat.

**Push never replaces the offer text; both go out.** On iOS a push only works
once the app is on the home screen (Share → Add to Home Screen), and a
marketplace that quietly stopped offering work to whoever had not installed it
would have a supply problem nobody could see.

The cleaner turns it on herself, from a button on her own screen, because every
browser requires a user gesture and a permission prompt that appears unprompted
is the one people deny — permanently, with no way to ask again.

### What is NOT built, and why it is not blocking

Phase 10 in the build plan also lists Capacitor wrappers and App Store / Play
submission. Those are procurement rather than engineering: an Apple developer
account ($99/yr), a Google Play account ($25), signing certificates, and review
queues measured in days. The installed PWA does everything the wrapper would do
for this business today, including notifications. Revisit it when there is a
reason a home-screen icon cannot answer — not before.

## Sign-in readiness and testing

In Supabase Authentication > URL Configuration, set Site URL to
`https://app.heyspotless.com`, not `http://localhost:3000`. Keep
`https://app.heyspotless.com/auth/callback` in Redirect URLs. The application sends
that fixed callback and carries the requested workspace in a short-lived,
same-site cookie. Old deployments that append `?next=%2Fadmin` need that exact
callback allowed until the fixed-callback release is deployed.

A link that lands on localhost is a redirect configuration problem. After saving
configuration, request a fresh email from the hosted app; an old email retains
its original destination. Open the newest link in the same browser and device
where you requested it, because the existing PKCE flow uses a browser verifier.

After authentication, /auth/continue verifies the user and profile, then sends
admins to /admin, cleaners to /cleaner, and customers to /customer. Customers and
cleaners also need their records linked by profile_id. Missing setup has a visible
explanation, rather than silently rendering empty account data. Assign roles and
record links deliberately through trusted administration; never self-promote
accounts based on email addresses or signup metadata.

For a first acceptance test, sign in as the owner and verify Management opens.
Then use separately provisioned cleaner and customer test accounts with linked
records. Test an expired link, a link opened in a different browser, and a new
unlinked account. Neither an email send success nor a passing unit suite proves
that a production mailbox received the message or that the role is provisioned.

If no email arrives, check the auth delivery log and SMTP configuration. The
default Supabase sender only permits the organization's team addresses; customer
and cleaner testing needs a configured production sender. Reference:
https://supabase.com/docs/guides/auth/auth-smtp
