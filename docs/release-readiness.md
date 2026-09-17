# Release readiness

The next product milestone is one complete service visit: a customer accepts a
quote and books, an administrator assigns the clean, a cleaner completes it,
and payment and receipt reconcile correctly. Keep manual scheduling available
while the dispatch engine is introduced.

Implementation and integration lead: Codex. Business acceptance: Matt and Maddie.
These are acceptance gates, not a claim that the remaining work is complete.

## Access controls

Migration `0007_access_controls.sql` restricts the four privileged billing
functions to `service_role`. Customer, cleaner and administrator browser
sessions cannot call them directly. Authenticated server routes continue to
use the service client after performing their own authorization checks.

Cleaner offers remain readable, but direct cleaner updates are disabled. The
future accept/decline operation must validate the transition and persist the
assignment atomically. Removing the broad update policy prevents changing
payouts through that same permission. Existing administrator updates remain.

Open-board jobs require a provisioned cleaner account. Customers retain access
to their own jobs. Signup always creates a customer profile; staff provisioning
is a separate privileged action.

`scripts/verify-access.sql` checks actual role behavior in the throwaway
PostgreSQL database, including forbidden billing calls and preserved server
payment recording. The migration verification script runs it in CI after the
existing pricing and billing checks. It deliberately tests broad table grants
and explicit function default grants, rather than relying on absent privileges.

Extended since: every privileged routine added in `0009`–`0012` is enumerated
there too, for anon, a customer, a cleaner and an admin browser session —
which uses the `authenticated` role like any other. The new tables follow the
same rule: a customer sees the credit that explains their settled invoice and
the collection attempt that explains a refused Pay button, neither for anyone
else, and can write neither. The service-role block confirms the other half —
that locking clients out did not lock the server out — by recording a refund
and its credit, saving and detaching a card, claiming and finishing a webhook
event, and joining an open collection attempt.

## Billing gates

Implemented and verified against a real PostgreSQL database on this branch.
Verified is not accepted: the business acceptance column is still open, and
none of this authorizes live payment activation.

| Gate | Status | Evidence |
|---|---|---|
| Refund and credit policy | Implemented, verified | `0011`. A refund states its `kind`; goodwill raises a matching credit so nothing becomes collectible. $170 paid, $50 goodwill → $120 retained, $0 outstanding, no charge. Full, partial-payment, tip, overpayment, correction, dispute, pending and failed cases all asserted. Policy written up in `docs/money-policy.md`. **Awaiting Matt or Maddie's approval of the worked examples.** |
| Uncertain payment recovery | Implemented, verified | `0012` + `lib/billing/collection.ts`. Every attempt is recorded before Stripe is called; a lost response or a dead process is reconciled against Stripe before anything else may collect. Stripe unreachable leaves the attempt open rather than treating it as a decline. |
| Webhook recovery | Implemented, verified | `0010`. Completed / processing / abandoned are three states, not two. Only a completed event is acknowledged; an event another handler holds gets a 409 so the delivery survives. Leases are owner-scoped. Termination after claiming, retry before and after expiry, concurrent deliveries, a database failure mid-processing, duplicates and out-of-order events are all asserted — at the route's response level, not only the store's. |
| Saved-card selection | Implemented, verified | `0009`. Saving a card never changes which card is default unless there is no default. Replay of either card, metadata update, detachment, promotion, replacement, re-attachment and two concurrent connections asserted. Removing the last card **suspends** autopay with a stated reason rather than leaving it silently unusable. |
| Concurrent collection | Implemented, verified | `0012`. At most one open attempt per invoice, enforced by a partial unique index under a row lock. Two tabs share one session; a repeated submission starts nothing; Checkout and the sweep block each other in both directions; two concurrent connections produce exactly one start. |
| Billing calendar dates | Implemented, verified | `0008` + `lib/time/zone.ts`. Scheduling resolves in America/Chicago (including the skipped and repeated hours); due dates are calendar days compared against today-in-Chicago. The suite is **not** pinned to a zone — `npm run test:zones` runs it under UTC and America/Chicago, and CI runs that. The SQL assertion runs with the session zone set to UTC, Chicago and Auckland. |
| Integrated verification | Partly done | All checks pass: the unit suites in both zones, typecheck, lint, build, all twenty-two migrations, and the SQL and role suites. **Stripe test-mode flows have STILL not been exercised.** What changed on 17 September is the reason: a deploy now exists at `app.heyspotless.com` against a live Supabase project, so the "nowhere to point a webhook at" half of this gate is closed. The remaining half is that production answers the Stripe webhook `503 billing is not enabled`, so no card, no webhook and no auto-charge has ever run against Stripe. This gate is open, and it is now the only thing between the app and taking money. |

## What production actually has, as of 17 September 2026

Checked against the live deployment rather than asserted from the code.

| Piece | State | How it was established |
|---|---|---|
| Vercel deploy | Live | `app.heyspotless.com` serves the current `main`, custom domain, HTTP 200. |
| Supabase | Live, migrated | `/admin/*` redirects to `/login?next=…` rather than erroring, and the dispatch sweep executes database functions from `0015` and `0019` without failing. |
| Auth | Live | Role gating in middleware is active; demo mode is off. |
| Cron secret | Set | The hourly dispatch sweep authenticates and returns 200; unauthenticated calls get 401. |
| Dispatch sweep | Green, hourly | Nine GitHub Actions runs, all successful, most recently 17 Sep 17:10 UTC. |
| Stripe | **OFF** | The webhook answers `503 billing is not enabled`. Either the key is unset or `BILLING_ENABLED=0`. |
| Twilio | Unknown from outside | Nothing external distinguishes configured from not. This is what `/api/health` now answers. |
| **Data** | **Empty** | Every sweep reports `{"jobs":0,…}`. The business is not in the database yet — phase 09. |

That last row is the one worth sitting with: **a green sweep against an empty
database is the most convincing wrong answer this system can give.** Nothing
fails, nothing happens, and the workflow log says "Sweep clean." Until the
Housecall Pro import lands, every green check above means the machinery works,
not that it is doing anything.

`GET /api/health` with the cron secret answers all of the above in one call,
including the row counts, in booleans and never in secrets.

## Communications

Built (`0022`). Phase 06. The platform can now hear as well as speak.

| Gate | Status | Evidence |
|---|---|---|
| STOP is honoured where it matters | Implemented, verified | Applied by **number**, not by role: a cleaner who is also a customer is opted out of both, asserted against real Postgres. The carrier half was always handled by Twilio's Advanced Opt-Out; this is the half that stops dispatch offering work to somebody who cannot see it and counting the expiry against her. |
| An inbound message is never lost | Implemented, verified | Recorded before it is interpreted, including from numbers nobody recognises. Phone matching normalises to the last ten digits, indexed, so `(214) 555-0143` and `+12145550143` are one person. |
| A retried delivery is not a second message | Implemented, verified | Unique on the provider's message id. Twilio retries anything it did not get a 2xx from, and a thread showing one sentence three times is a thread nobody trusts. |
| The webhook cannot be forged | Implemented, tested | HMAC-SHA1 over the URL and every parameter, compared in constant time, signed against the configured public origin rather than the proxy's idea of it. Tampered body, tampered sender, wrong token, wrong URL and a short signature are all asserted. |
| One reminder per visit, and it follows a reschedule | Implemented, verified | Keyed on `job:<uuid>:<action>`. The hourly sweep converges rather than accumulating, a moved visit moves its unfired reminder, and a fired one is history — it does not move and does not fire again. |
| Two sweeps do not double-text | Implemented, verified | A lease with an owner and an expiry, the same shape as the webhook leases in `0010`. A stranger's settle changes nothing; a failure releases rather than fires. |
| Nothing is sent at night | Implemented | The firing pass is skipped between 8pm and 8am in Dallas. Rows stay due. **When this queue grows an action that is not a message, this guard has to move down to the message actions rather than gating the whole pass.** |
| A rating reaches the gate | Implemented, verified | `record_rating` recomputes `cleaners.rating`, which is the column the `0003` eligibility CHECK reads — so a cleaner who drops below 3.9 stops being offered work on the next sweep, not the next morning. Revising a rating replaces it rather than adding a vote. |

Open, and worth stating plainly:

- **The review link is the credential.** A job id in an SMS is what authorises a
  rating: 122 random bits, sent only to the number on the customer's record,
  usable only while the job is complete, and good for one rating. That is the
  same bargain every one-tap review link makes, and it is written down rather
  than assumed. What a guessed id buys is one rating on a stranger's clean and
  no read access to anything.
- **The inbox is unpaginated**, bounded at 400 messages. Correct for a
  two-person office, wrong for a ten-person one.
- **Nothing has been sent to a real handset yet.** The same gap billing has:
  verified against Postgres, never against the provider.

## Recurring scheduling

Built (`0014`). Frequency sets the rate; "repeat this automatically" starts a
plan. Visits are generated six weeks ahead by `/api/recurring/generate`,
idempotent on `(plan, occurrence date)` and asserted against three concurrent
sweeps. Skips are rows with reasons, and skipping one visit does not move the
rest. The agreed rate lives on the plan, which closes gate 5 below and the
overbilling exposure in `docs/setup.md` item 7 **for future visits** — it does
nothing about invoices already sent.

Remaining gap, not blocking a pilot:

- Customers cannot yet see their own schedule; the plan and its skips are
  admin-only surfaces.

## The offer lifecycle and continuity

Built (`0015`). Closes the two gaps this document listed above.

| Gate | Status | Evidence |
|---|---|---|
| An offer can be answered | Implemented, verified | `respond_to_offer`. Accept, decline, expire, supersede and "taken" are five outcomes, not two. The payout on the assignment is read off the offer row; the function takes no amount, which is what stops the endpoint handing back the permission `0007` removed. |
| One job, one assignment | Implemented, verified | The function locks the **job**, not the offer — locking each cleaner's own row would let both through. Two concurrent accepts produce exactly one assignment and one `taken`, asserted with genuinely concurrent connections. |
| The eligibility gate still holds | Implemented, verified | `record_offer` cannot write an offer the `0003` CHECK would refuse. Asserted against a cleaner below the 3.9 floor. |
| A losing cleaner is not penalised | Implemented, verified | A cleaner who loses a race has her offer **withdrawn**, not declined. Acceptance rate drives ranking, so counting work that no longer existed against her would punish the cleaners who answer fastest. |
| Continuity is honoured and priced | Implemented, tested | `lib/dispatch/continuity.ts`, pure and asserted without a database like the rest of dispatch. The incumbent is held for or assigned before anything else runs; what that costs against the cheapest alternative is recorded on every decision. |
| Interventions are countable | Implemented | `dispatch_decisions.decided_by`. Null means the engine decided. **Nothing is reporting on it yet** — the column is populated, the metric is not calculated anywhere. |

**Settled (Matt, 12 September 2026).** The continuity premium cap was shipped
at 15% of the ticket and applied to any incumbency the customer had not
explicitly asked for. It fired constantly: the comparison that matters is
almost always against an idle W-2 inside guaranteed hours, which costs nothing,
so the premium was a contractor's whole payout — 33–36% of the ticket at every
job size on the current pricelist. The effective rule was "a customer loses
their cleaner whenever Shonda has a spare hour".

The policy is now that a relationship ends for a **reason** — the customer asks
for somebody else, the customer complains, the cleaner cannot take it, or she
turns it down — and never on cost. `0017` gives the first two somewhere to live
(`property_cleaner_blocks`) and turns the cap off by default. The premium is
still recorded on every decision.

**Follow-on, settled 14 September 2026.** The spread question is closed by
`0018`: the payout is 33% of the ticket, so `agreed_price_cents` times a
constant share fixes the margin on a recurring relationship by construction.
`agreed_payout_share` now records a *negotiated* exception and is almost always
null — there is no rate to agree per relationship in the ordinary case, which
removes the "nothing turns the key" gap this section previously listed.

**Still open, and now sharper:**

- **Acquisition on new recurring customers.** A flat share pays worst on the
  discounted jobs. An existing recurring customer is protected — her visit goes
  to her incumbent exclusively — but a NEW weekly has no incumbent and is the
  worst-paying job on the open board. `MINIMUM_PAYOUT_CENTS` in
  `lib/pricing/payout.ts` is the lever and is off. **Watch time-to-fill on new
  recurring customers specifically**; if it is worse than one-time work of the
  same size, that is this.
- **Escalation on an established relationship.** An escalated rung is still a
  one-off for that visit; the standard share stands next time. A pairing that
  escalates every week is one whose share is below market for that customer,
  and it should surface as an exception for a person to re-agree rather than
  repeat forever. Nothing surfaces it yet — the data is in `offers.payout_pct`.
