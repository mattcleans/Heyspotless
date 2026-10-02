# Hey Spotless experience release

This release builds on the existing Next.js application. The requested sequence is web first, then native iOS and Android. Housecall Pro remains the current operating system. This branch does not connect or migrate its live records.

## Design

The customer-flow PDF establishes ocean blue (#075e7b), sunshine (#fae47a), white (#ffffff), pale blue (#e8f5f8), and readable slate (#526977). System sans type keeps the app fast and familiar on phones. A large welcoming headline and one rounded blue booking panel carry the identity. Visit details and actions remain left aligned. Bottom navigation identifies the current customer area. Cleaner screens use the same brand with a focused daily workspace, while management has a wider overview.

## Implemented

- Customer home prioritizes an existing visit, reads the actual assignment stage, offers a recent-clean feedback path, and provides direct phone support.
- Customer navigation identifies the current tab. Service links preserve the selected service in the estimate form.
- The inquiry flow has home/service, details, and review steps. It explicitly says a request is not a confirmed booking. Text consent starts unchecked. Preview mode cannot submit requests.
- Cleaner workspace separates daily visits, available offers, and upcoming appointments. It uses the business timezone, preserves booked appointment order, and does not truncate today's schedule to four visits. Missing live cleaner profiles do not fall back to an unfiltered job query.
- Contractor visit cards read agreed assignment pay. Employee cards refer to hourly terms rather than displaying a contractor percentage. Missing pay is not invented.
- Management overview at /admin shows local-day counts, missing visit times, late unstarted work, and unassigned visits in the next 24 hours. It links to the existing customer, dispatch, inbox, and lead workflows.

## Release boundaries

This is a working experience increment, not certification that the entire platform is ready to replace Housecall Pro. Existing booking is lead intake. Instant availability, reservation locking, payment confirmation, individual rescheduling and recurring-plan editing still need end-to-end implementation and acceptance. Client-confirmed cancellation and single-visit skips are implemented but require authenticated acceptance.

Clients can request a preferred cleaner for an own, unstarted visit from the visit details or a published profile. The office reviews the request and applies an eligible preference to normal matching without directly assigning a contractor or promising acceptance. Any assigned lead different from the visit's preferred cleaner requires that client's approval for that specific assignment before starting work. Requests and approvals are visit-specific; they do not rewrite a recurring plan. A new backup needs fresh consent. The office can release a client-declined, unstarted single assignment for matching; that backup stays excluded from the visit unless the client explicitly requests them again and the office applies that new preference. A crew needs manual office review.

Deploy `20261001200000_client_cleaner_choice.sql` through the normal migration process before enabling these workflows. The new choice pages fail with recovery if the schema is absent. Existing visit tracking keeps its timing/photo evidence but explicitly labels unavailable assignment data while the safe views are awaiting deployment. No live migration has been run by this work. Confirm the preview's non-production database and disabled provider settings before acceptance mutations.

Housecall Pro requires verified account/API access and a defined record owner before integration. Establish customer/property/job ID mappings, deduplicated imports, cancellation handling, reconciliation, and one billing owner per visit. There is currently a CSV importer, not a verified bidirectional sync. Do not enable parallel charging.

Before a live pilot, verify customer and cleaner account permissions, a real visit from request through completion, agreed pay, review/tip collection, failure recovery, and payment authorization in a non-production environment. Test offline cleaner photo recovery on a physical phone. Configure market timezone and service coverage before entering another market; current screens label Dallas accurately.

## Validation

- 1,351 tests pass in both UTC and America/Chicago; five existing live-service tests remain skipped. TypeScript, ESLint and the production webpack build pass.
- The full migration chain and availability, home-instruction, cleaner-choice and cancellation SQL regressions pass in an isolated PGlite PostgreSQL engine. CI runs those exact scripts against PostgreSQL 16.
- Cleaner-choice checks cover ownership/role gates, strict saved receipts, bounded reads, stale decisions, immutable assignment/cleaner/client consent, request replacement, review retries, release retries, retained audit history, declined-cleaner exclusion and blocked starts/completion without an approval.
- Local browser checks use explicitly labeled fixtures without provider credentials. Backup review is prioritized above request history; approved, declined and started states have distinct copy. Notes survive rejected saves and session expiration. Client and cleaner refresh controls work. The 390px layouts have no horizontal overflow and new choice/review controls are at least 44px high. Preview saves remain disabled. Temporary review routes were removed before the final suite/build.
- Existing photo durability, home editing, pay filtering and executive photo/invoice review evidence is recorded in `docs/ux-review/completion-audit.md`.
- Authenticated preview access, representative three-role test visits, concurrent database connections, physical-phone offline recovery and provider/payment acceptance remain unverified. These local checks are not proof of those release gates.


## Cancellation policy and release gate

The confirmed policy is $60 only for cancellations on the appointment day or door turnaways, using Dallas time. Prior-day cancellations are free even within 24 hours. Clients review the exact fee before confirming their own cancellation or one-occurrence skip. A skip does not alter the recurring schedule. Office-only turnaway recording uses the same quote/confirmation flow.

Apply `20261001210000_visit_cancellations.sql` after the cleaner-choice migration through the normal deployment process. New cancellation pages fail with recovery before deployment. Existing account balances remain accessible when the cancellation table is absent. Do not treat a preview fixture as a live saved cancellation.

Cancellation keeps audit and assignment history, suppresses recurring regeneration and withdraws outstanding offers. Unpaid service invoices are voided, while a $60 fee becomes a distinct invoice with the existing collection lock and consent rules. Captured or in-flight payments pause additional collection and require office reconciliation. An office recheck can finalize billing only after existing payments are fully refunded and pending provider attempts/refunds are resolved. It records a fee invoice once without sending a refund or initiating payment.

Verify an owned free cancellation and skip, a same-day fee, an office turnaway, stale review/retry, refused old offer/start, and a fully reconciled payment exception in a confirmed non-production environment before release. These source changes do not apply a live migration, activate providers, send a message or charge a card.


## Free rescheduling release gate

Rescheduling is free even on the appointment day. Apply `20261001220000_visit_rescheduling.sql` after cancellations before deploying the updated app: job reads and dispatch now require its revision column/RPCs. Client and office visit pages offer a review-and-confirm flow for one future appointment. Dallas time and the unchanged service price are explicit. Invalid spring clock-gap times are refused; the repeated autumn hour resolves to the first occurrence.

A saved move keeps the visit and recurring occurrence, releases the prior assignments with private agreed-pay history, withdraws old offers and opens matching for the new time. The contractor must accept a new offer; a different backup still needs client approval. No rescheduling fee, invoice mutation, provider message, refund or payment is initiated by this action. Client/office change history and cleaner release history explain the move.

Verify a free same-day move, retained captured invoice, recurring regeneration, cleaner release/new acceptance, fresh backup approval, lost-response retry, stale review, and both start/reschedule lock orders in a confirmed non-production environment. The recurring schedule editor remains implementation work. Local validation: 1,414 passing tests in each time zone, five skipped live-service tests, full isolated SQL regressions, and mobile review/recovery at 390px and 320px. Final PostgreSQL race CI and authenticated browser acceptance must be checked separately.
