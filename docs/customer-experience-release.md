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

This is a working experience increment, not certification that the entire platform is ready to replace Housecall Pro. Existing booking is lead intake. Instant availability, reservation locking, payment confirmation and rescheduling/skipping still need end-to-end implementation and acceptance.

Clients can request a preferred cleaner for an own, unstarted visit from the visit details or a published profile. The office reviews the request and applies an eligible preference to normal matching without directly assigning a contractor or promising acceptance. Any assigned lead different from the visit's preferred cleaner requires that client's approval for that specific assignment before starting work. Requests and approvals are visit-specific; they do not rewrite a recurring plan. A new backup needs fresh consent. The office can release a client-declined, unstarted single assignment for matching; that backup stays excluded from the visit unless the client explicitly requests them again and the office applies that new preference. A crew needs manual office review.

Deploy `20261001200000_client_cleaner_choice.sql` through the normal migration process before enabling these workflows. The new choice pages fail with recovery if the schema is absent. Existing visit tracking keeps its timing/photo evidence but explicitly labels unavailable assignment data while the safe views are awaiting deployment. No live migration has been run by this work. Confirm the preview's non-production database and disabled provider settings before acceptance mutations.

Housecall Pro requires verified account/API access and a defined record owner before integration. Establish customer/property/job ID mappings, deduplicated imports, cancellation handling, reconciliation, and one billing owner per visit. There is currently a CSV importer, not a verified bidirectional sync. Do not enable parallel charging.

Before a live pilot, verify customer and cleaner account permissions, a real visit from request through completion, agreed pay, review/tip collection, failure recovery, and payment authorization in a non-production environment. Test offline cleaner photo recovery on a physical phone. Configure market timezone and service coverage before entering another market; current screens label Dallas accurately.

## Validation

- 1,280 tests pass in both UTC and America/Chicago; five existing live-service tests remain skipped. TypeScript, ESLint and the production webpack build pass.
- The full migration chain and availability, home-instruction and cleaner-choice SQL regressions pass in an isolated PGlite PostgreSQL engine. CI runs those exact scripts against PostgreSQL 16.
- Cleaner-choice checks cover ownership/role gates, strict saved receipts, bounded reads, stale decisions, immutable assignment/cleaner/client consent, request replacement, review retries, release retries, retained audit history, declined-cleaner exclusion and blocked starts/completion without an approval.
- Local browser checks use explicitly labeled fixtures without provider credentials. Backup review is prioritized above request history; approved, declined and started states have distinct copy. Notes survive rejected saves and session expiration. Client and cleaner refresh controls work. The 390px layouts have no horizontal overflow and new choice/review controls are at least 44px high. Preview saves remain disabled. Temporary review routes were removed before the final suite/build.
- Existing photo durability, home editing, pay filtering and executive photo/invoice review evidence is recorded in `docs/ux-review/completion-audit.md`.
- Authenticated preview access, representative three-role test visits, concurrent database connections, physical-phone offline recovery and provider/payment acceptance remain unverified. These local checks are not proof of those release gates.
