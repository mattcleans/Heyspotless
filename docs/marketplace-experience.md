# Hey Spotless marketplace experience

Product direction, October 6, 2026: make Hey Spotless the “Uber for Maids” across
Clients, Cleaners and Executives. A Client can arrange a clean confidently, a
Cleaner can understand and choose their work, and Management can resolve the
exceptions that prevent reliable service. Keep Hey Spotless’s own brand and
existing employee and contractor agreements.

This is the delivery contract for that direction. The phases below sequence the
work; completing one phase does not complete the overall objective. Existing
[release gates](release-readiness.md), [preview acceptance](preview-acceptance.md)
and [three-role audit](ux-review/completion-audit.md) continue to apply. Historical
“implemented” or “verified” entries need current runtime evidence before launch.

## Problem and intended outcome

The app already contains pricing, quotes, recurrence, eligibility, offers,
assignment, service evidence and payment recovery. The customer-facing path still
starts with a public estimate and lead submission. Acceptance of reviewed terms
then waits for Office booking, and matching recommendations are separate from
saved offers. Users need a coherent path with a clear next action, visible saved
status and honest recovery whenever supply, connectivity or payment is uncertain.

The experience must reduce repeated data entry and office intervention while
preserving exact prices, Cleaner agreements, Client consent and reliable records.
Speed must come from fewer steps and dependable matching, with capacity-backed
appointment promises. An estimate, requested time or calculated recommendation
must never appear as a confirmed booking or assignment.

## Journey and shared state contract

1. Client chooses their saved home, service, extras, cadence and appointment.
2. Client reviews the exact price, repeating commitment, fees and appointment
   status, then confirms the request once.
3. Saved booking and matching records establish whether an appointment is
   confirmed or still needs scheduling. No available match produces an actionable
   alternative or Office follow-up, with the Client’s choice retained.
4. An employee is assigned under existing terms, or a contractor receives and
   accepts a real offer with agreed pay and a recorded deadline.
5. An actual backup requires the Client’s approval of that exact assignment
   before work starts. A preferred-Cleaner request alone promises no assignment.
6. Cleaner follows their current visit, captures required evidence, and finishes
   only after the server confirms the required records. Client sees actual progress.
7. Invoice, payment and receipt reconcile. Agreed Cleaner pay, payment recorded in
   the app and a provider-confirmed transfer remain distinguishable.

Each screen derives state from the current saved records for its role. Browser
refresh, a second tab, a delayed response and a changed assignment must preserve
these distinctions. All appointment and fee boundaries use Dallas time.

## Requirements and acceptance

### P0 — dependable service for all three groups

| ID | Requirement | Acceptance evidence |
|---|---|---|
| C1 | Returning Clients book from their owned, verified home and contact details, reviewing changes instead of retyping everything. New Clients can establish a usable account and home. | Actual new and returning Client journeys; cross-client home access denied; changes reviewed before saving. |
| C2 | Show exact service, extras, price per clean, cadence, first appointment and whether visits repeat before confirmation. Retain the choice when supply is unavailable. | Saved quote/request matches every reviewed term; retry creates one outcome; unavailable capacity offers an honest next step. |
| C3 | Let Clients confirm individual and recurring changes with the correct fee and scope. | Earlier-day changes and same-date appointment-day time changes are free; appointment-day cancellation, move to another date and door turnaway cost $60. Recurrence exceptions survive generation and retries. |
| C4 | Make preferred requests, actual assignments and exact backup approval understandable. | Preferred request survives reload; Office outcome is visible; changed backups cannot inherit consent; no unapproved start or completion. |
| C5 | Home prioritizes the next action for the current visit, with readable status, evidence and contact help. | Actual matching, assigned, waiting for approval, ongoing, complete, canceled and overdue visits; unavailable reads show recovery. Estimates never imply completion. |
| C6 | Give Clients clear invoices, payment outcomes, consent and feedback receipts. | Provider test-mode collection and uncertain-response reconciliation; no duplicate charge; disabled billing is honest; saved ratings reload with correct Cleaner identity. |
| K1 | Cleaners see real offers with appointment, work, agreed pay, deadline and travel information sufficient to decide. | Actual contractor accept/decline and expiration; concurrent acceptance preserves capacity and one assignment; no other Cleaner’s pay or private Client billing. |
| K2 | Cleaner My day shows ongoing work, confirmed visits and changes with a useful primary action. | Actual cross-date ongoing visit and schedule/release changes; canceled or released work cannot retain private home access or start controls. |
| K3 | Service capture remains usable through weak connectivity and application restart. | Physical-phone photo/checklist persistence, offline/reconnect, storage pressure and update recovery; one server record per required slot; Done cannot discard unsent evidence. |
| K4 | Working hours, availability and pay are accurate and actionable. | Overlap refusal; available/unavailable matching; employee hourly terms kept distinct from contractor visit fees; agreed, recorded and provider-confirmed payment states distinguishable. |
| E1 | Executives have one actionable view of visits that need intervention, with links to current records. | Capacity gaps, overdue visits, declined backup, expired offer, withdrawn acceptance, missing evidence and uncertain payment lead to the correct guarded recovery. |
| E2 | Office review and matching use the current Client preference, capacity, assignment and approval. | Actual preference apply/decline, saved offer/assignment and Client receipt; no stale review can overwrite a new request or reopen canceled work. |
| E3 | Office can replace a crew lead without changing the retained team’s agreement or Client price. Saved outcomes remain reviewable after reopening. | Actual contractor and employee paths, decline/expiry/restoration, retained teammates, outgoing-Cleaner release and exact Client approval; historical receipt cannot imply a current assignment. |
| E4 | Office can review accepted booking terms and recurring changes without reconstructing the agreement from notes. | Actual one-time and recurring booking, extras/cadence changes, changed-home and expired/stale approval refusal; first visit and future generation preserve the accepted terms. |
| E5 | Automation and provider health explain failure and recovery without promising a successful action prematurely. | Protected deployed dispatch/recurrence/health checks; provider messaging/payment tests; failures remain visible and retries do not duplicate offers, visits, messages or collections. |
| S1 | Every role has reliable account setup, password sign-in, recovery and sign-out with its saved permissions. | Ordinary sign-in and recovery separately verified for all approved roles; realistic email delivery; sign-out removes private access. |
| S2 | Each role works comfortably on a phone and with keyboard/assistive navigation. | Role journeys at narrow widths, readable hierarchy, useful names and errors, reachable controls, focus recovery and physical-device acceptance. |
| S3 | Ownership and saved-state truth hold across all paths. | Anonymous, wrong-role and foreign-record denial; stale and concurrent writes refused; lost responses recover to the recorded outcome. |

### P1 — reduce effort after the dependable path is proven

- Rebook from a previous clean with saved-home and service choices, while reviewing
  the current price and appointment availability.
- Provide proactive, consented status updates and clear response deadlines using
  actual offer and assignment records.
- Explain unavailable matches, release reasons and Office decisions in the affected
  role’s own workspace, preserving the choice needed for a retry.
- Improve Cleaner onboarding and eligibility visibility, with accurate employee or
  contractor terms and a clear explanation of the next requirement.
- Give Management trustworthy service and supply metrics with defined denominators
  and useful links to the underlying exceptions.

These enhancements remain part of the marketplace direction. They must not bypass
P0 reliability, privacy, payment or representative-usability gates.

## Current implementation and next delivery slices

| Surface | Current evidence | Work needed |
|---|---|---|
| [Public booking](../src/app/book/booking-widget.tsx) and [lead intake](../src/app/api/leads/route.ts) | Estimate plus contact/home inquiry; server recomputes price. | Persist an owned booking request that reuses verified details, retains choices and makes capacity/confirmation status explicit. |
| [Client workspace](../src/app/customer/page.tsx) and [quotes](../src/components/quotes/quote-card.tsx) | Saved terms, decisions, booking links and guarded changes exist; many synthetic role journeys verified. | Close remaining Client sign-in and recurring receipt gates; connect the low-effort booking path to these saved records. |
| [Matching](../src/app/admin/dispatch/page.tsx) and [dispatch sweep](../src/app/api/dispatch/run/route.ts) | Recommendations and persisted dispatch are separate implementations. Preference and eligibility logic exist. | Earn deployed saved dispatch, offer delivery/acceptance and no-supply recovery; measure latency and Office intervention before making a service promise. |
| [Crew review](../src/app/admin/visits/[id]/replace-lead/replacement-form.tsx) | Contractor replacement and exact Client approval earned in the isolated preview; reopened history correction under verification. | Verify corrected history, employee/restoration/outgoing-Cleaner cases and capacity races in the actual role workspaces. |
| [Cleaner earnings](../src/app/cleaner/earnings/page.tsx) and service capture | Agreed pay and payment records are separated; synthetic uploads/completion earned. | Provider-confirmed payment journey and physical-phone recovery remain open. |
| [Automation](../src/app/admin/automation/page.tsx) | Health/exception surfaces exist in code. | Earn protected deployment/provider checks and make every unresolved service outcome actionable. |

Slice 1 closes the remaining service, role, provider and device acceptance gaps.
Slice 2 joins saved-home booking requests, exact terms and capacity-backed
confirmation into one Client path. Slice 3 improves matching recovery and supply
choices, then reduces routine Office work using measured service outcomes.

## Success measures

Record a baseline before claiming improvement. Suggested evaluation targets are
hypotheses for product testing, not promises to customers:

- Returning Client active time from Book another clean to a saved, clearly stated
  outcome: aim for under two minutes, excluding deliberate reading and supply wait.
- Independent task completion for each group: booking/change/status for Clients;
  offer/service/pay for Cleaners; exception resolution for Executives. Require
  representative users to complete their critical tasks without coaching.
- Measure request-to-confirmed-match latency, unfilled appointments, Office touches
  per clean, on-time starts and repeat-booking completion by actual saved transitions.
- Correctness targets: zero duplicate visits or charges from retries, zero
  unapproved backup starts, zero lost acknowledged captures, and zero cross-role
  or cross-customer exposure in the tested cases.

## Owner decisions needed before dependent implementation

Matt and Maddie own the appointment promise and operating coverage: exact start,
arrival window, instant confirmation eligibility and the acceptable no-supply path.
Cleaner minimum-pay and payout timing/fee decisions must be explicit before new
marketplace promises are shown. Public feedback publication rules also need an
explicit decision before private visit feedback becomes public.

Provider test credentials, real email delivery, approved role actors and physical
devices are acceptance dependencies. Record them when available and keep useful
independent work moving while they are pending. Existing $60 fee, free same-date
time changes, Client recurring control and exact backup approval decisions stand.
