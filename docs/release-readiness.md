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

## Scheduling limitation

Selecting a frequency books **one** clean at the recurring rate. It does not
create the series, and nothing in the application will. Generating recurring
visits, skipping, rescheduling and holding legacy rates are unbuilt.

Stated in the booking form, the README and here, because the dropdown looks
exactly like one that does schedule a series. Recurring customers stay in
Housecall Pro until it exists.

## Customer and operations gates

1. Persist the accepted service scope, price and recurring discount.
2. Create and change bookings through supported screens with capacity checks.
3. Assign work and let the cleaner record completion through their own account.
4. Show upcoming visits, invoices, receipts and payment authorization to customers.
5. Generate recurring visits without duplicates and preserve locked legacy rates.
6. Pilot a small, representative customer group with daily job and money reconciliation.
7. Verify migrated history and future visits, rehearse rollback, and complete the
   planned parallel run before retiring Housecall Pro.

During parallel operation, identify the authoritative system for each job,
message and payment. Only one platform may automatically collect for a visit.

Track implemented, integrated, verified, piloted and accepted separately.
Measure completed-customer acquisition cost, booking conversion, administration
minutes per completed job, contribution per job and total software ownership
cost against the existing business baseline.
