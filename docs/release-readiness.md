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
| Integrated verification | Partly done | All checks pass on the combined branch: 357 unit tests in both zones, typecheck, lint, build, all twelve migrations, and the SQL and role suites. **Stripe test-mode flows have NOT been exercised** — no Stripe credentials are configured in this environment, and no staging deploy exists to point a webhook at. This gate is open. |

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

**Open:** the continuity premium cap (`MAX_CONTINUITY_PREMIUM_FRACTION`, 15% of
the ticket) is a stated default in the absence of better information, in the
same posture as the unattributed-refund split. It decides when a customer gets
substituted to save money and **needs Matt or Maddie's number**, not an
engineer's. The data to set it is now being recorded.

## Customer and operations gates

1. Persist the accepted service scope, price and recurring discount.
2. Create and change bookings through supported screens with capacity checks.
3. Assign work and let the cleaner record completion through their own account.
4. Show upcoming visits, invoices, receipts and payment authorization to customers.
5. ~~Generate recurring visits without duplicates and preserve locked legacy rates.~~
   Done — `0014`, verified against concurrent sweeps.
6. Pilot a small, representative customer group with daily job and money reconciliation.
7. Verify migrated history and future visits, rehearse rollback, and complete the
   planned parallel run before retiring Housecall Pro.

During parallel operation, identify the authoritative system for each job,
message and payment. Only one platform may automatically collect for a visit.

Track implemented, integrated, verified, piloted and accepted separately.
Measure completed-customer acquisition cost, booking conversion, administration
minutes per completed job, contribution per job and total software ownership
cost against the existing business baseline.
