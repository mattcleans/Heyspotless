# Release readiness

The next product milestone is one complete service visit: a customer accepts a
quote and books, an administrator assigns the clean, a cleaner completes it,
and payment and receipt reconcile correctly. Keep manual scheduling available
while the dispatch engine is introduced.

Implementation and integration lead: Codex. Business acceptance: Matt and Maddie.
These are acceptance gates, not a claim that the remaining work is complete.

## First change: access controls

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

## Remaining billing gates

| Gate | Required acceptance evidence |
|---|---|
| Refund and credit policy | A goodwill refund does not create a new collection obligation. Gross history and net retained revenue remain distinguishable. Matt or Maddie approves partial, full, tip and overpayment examples. |
| Uncertain payment recovery | A successful charge followed by a timeout or database failure cannot create another charge before reconciliation. |
| Webhook recovery | Termination after claiming an event is recoverable. Duplicate and out-of-order deliveries converge to the correct state. |
| Saved-card selection | Replacing a default card leaves exactly one intended default; failures and concurrent updates are exercised. |
| Concurrent collection | Two Checkout tabs, a repeated submission, and Checkout overlapping automatic collection cannot collect twice for the same obligation. |
| Billing calendar dates | Due dates behave consistently in America/Chicago and UTC. The current test suite fails its future-due-date case when run in America/Chicago; do not resolve this by only forcing CI to UTC. |
| Integrated verification | Run all checks on the combined branch and exercise Stripe test-mode flows. A green unit suite alone is insufficient. |

These access-control changes do not resolve the remaining billing gates and
do not authorize live payment activation.

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
