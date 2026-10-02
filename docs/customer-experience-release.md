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

This is a working experience increment, not certification that the entire platform is ready to replace Housecall Pro. Existing booking is lead intake. Instant availability, reservation locking, payment confirmation still needs implementation; recurring-plan editing requires authenticated acceptance; individual rescheduling requires authenticated acceptance. Client-confirmed cancellation and single-visit skips are implemented but require authenticated acceptance.

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


## Appointment changes release gate

The final client policy is $60 for appointment-day cancellations, door turnaways, and appointment-day rescheduling to a different calendar day. Moving to a different time on the same appointment day is free. Earlier-day rescheduling is free, including the previous evening within 24 hours. All day boundaries use America/Chicago.

Apply the migrations in order, including `20261001220000_visit_rescheduling.sql`, `20261002003748_recurring_generation_versions.sql`, and `20261002004617_appointment_day_reschedule_fee.sql`, before deploying this increment. Dispatch requires appointment revision RPCs; recurring generation requires the plan revision RPC. The updated app requires the new fee-review RPC, so an older database cannot silently quote the superseded free policy. Previously issued free rescheduling reviews expire at the fee-policy migration and must be reviewed again.

The five-minute review shows the exact $0/$60 fee, Dallas appointment times, unchanged clean price and cleaner release. Confirmation rechecks the fee at the current Dallas day boundary, rejects stale reviews, and returns the same saved receipt on retry. A paid change creates one separate $60 customer invoice linked to its receipt; existing clean invoices/payments stay intact. The fee invoice has no service job ID, so later clean completion cannot mistake it for the clean invoice. It is labeled in account history and checkout, excludes tips, and uses explicit account checkout. Current stored-card consent covers clean invoices; this fee is excluded from the autocharge sweep and guarded against off-session collection in SQL. Confirmation itself makes no provider call or card charge.

A saved move keeps the visit and original recurring occurrence, releases old assignments with private agreed-pay history, withdraws old offers and opens matching for the new time. New backups still need client approval. The versioned recurring generator refuses an older plan snapshot; compatibility callers create new visits from the locked current cadence, bounds and Dallas wall clock. Individual moves, skipped occurrence identities, service prices and payout shares are preserved. DST behavior matches the existing schedule engine.

Before release, verify a same-day time change, appointment-day move to another day, prior-evening move, retained paid clean invoice, one fee invoice under retries, fee checkout, recurring regeneration, cleaner release/new acceptance, fresh backup approval and session/stale-review recovery in a confirmed non-production environment. Recurring schedule editing is implemented in the increment below; representative authenticated three-role acceptance remains outstanding. These changes do not apply a live migration, activate providers, send a message or charge a card.


## Client-confirmed recurring schedule changes

Clients and office staff can review and confirm changes to frequency, first date, Dallas arrival time, optional pause-through date and optional last date. Links are available from client Account/Visits and the office client record. Monthly cadence follows the anchor’s numbered weekday, with fifth-weekday clamping. Pause-through dates are inclusive. Service/home/preferred cleaner and payout share are preserved. Day/time edits retain the agreed price; frequency changes quote the current price book for explicit client review. Unsupported service frequencies are excluded from new choices and rejected in SQL. Imported agreed patterns can keep their current frequency.

Changes take effect tomorrow in Dallas. Today’s appointment stays booked and follows the individual cancellation/rescheduling policy: $60 to cancel or move it to another day, free to move it to another time today. The recurring review has no change fee. It lists every existing future appointment affected, and each new occurrence through the selected first date plus the plan’s generation horizon. Billed, started, recorded-work and individual exceptions keep their actual time, price and assignment. Exact-date exceptions claim matching slots first; nearby exceptions explicitly fill a reviewed new occurrence. Unmatched exceptions remain visible and can be changed separately. A later sweep uses a retained exception instead of making a second clean on its actual day when that day fits the future pattern. Literal skipped dates remain skipped.

Confirmation uses plan/job/invoice locks and compares the complete private snapshot plus the current price review. New generation epochs allow repeat edits without deleting canceled/completed occurrence history or recreating old slots. Ordinary future visits move with their IDs where possible; excess visits are canceled for free; new pattern visits are materialized immediately. Moved/removed visits withdraw prior offers and release assignments into private agreed-pay history. Kept visits retain accepted terms, including when no stored end time exists. Each saved change has an idempotent receipt and per-visit audit. Clients/office see the latest three pattern changes in visit details and cancellation/rescheduling records; cleaners see their own recent releases, including removals. Removed visits cannot be reopened, newly invoiced or collected by stale workers. Individual quotes also capture their generation epoch so metadata-only reassignment invalidates old cancellation/rescheduling reviews without invalidating accepted terms of retained cleaner offers.

Apply `20261002020509_client_recurring_schedule_editor.sql` after all prior migrations before deploying this editor. Actor-scoped read RPCs return only client dates, prices, home street/city and literal skips; they do not add broad plan SELECT grants or expose payout shares, access notes, gate codes or assignment snapshots. Receipt and release reads use role/owner RLS. Inactive plans remain readable by their owner for saved history and retries but are excluded from the active list.

Validation: 1,487 tests pass in both UTC and America/Chicago, with five existing live-service tests skipped. TypeScript, lint and production webpack build pass locally. The complete migration chain, original SQL blocks, eight workflow SQL regression files and both race scripts’ SQL blocks pass in isolated PGlite. The PostgreSQL 16 verifier additionally runs separate connections with observed lock barriers for recurring start-first/edit-first, stale dispatch/generation, concurrent confirmation retries and generation-first invalidation. Exact-commit CI must confirm the concurrent runs. Local sample browser checks cover frequency/price review, all four visit actions and lost-response retry at 390px/320px, with no horizontal overflow and at least 44px action targets. Temporary UI/API fixtures were removed before final checks.

Release gates remain: confirmed non-production schema/provider settings, preview sign-in and representative authenticated acceptance across all three roles. Instant confirmed booking, physical-phone offline/provider payment acceptance and crew resolution remain separate work. No live migration, real appointment mutation, provider message, payment/refund, account permission change or merge was performed.

## Isolated preview preparation

Follow [the preview acceptance setup](preview-acceptance.md) to bind the PR deployment to a verified Supabase development branch and confirmed preview Auth identities. `npm run preview:prepare` produces a private ordered migration/hash manifest, 26 read-only schema/grant probes, disabled-provider environment template and a guarded synthetic fixture. It makes no remote calls. The generated fixture creates a signed-in client/home, a signed-in cleaner with two accepted assignments, a specific backup-approval scenario, appointment-day/advance change examples and three materialized weekly occurrences. Target acknowledgement, fresh-database and confirmed-account checks run before role changes.

The migration verifier now executes the actual generated fixture in its empty disposable database, checks the role records and exact backup approval, and rolls all fixture/schema changes back before the existing price-book and workflow checks. This prepares repeatable acceptance; it does not provision a branch, establish Vercel access or prove browser acceptance. Confirm paid branch organization/cost and deployment protection access before provisioning.


## Stale review conflict responses

Apply `20261002233405_stale_review_http_conflicts.sql` after the recurring editor. Seventeen exact workflow functions now raise `PT409` for stale appointment, fee, assignment, home instruction and recurring-plan reviews. This maps directly to HTTP 409; it avoids treating a business conflict as a database serialization retry. Genuine PostgreSQL serialization failures and deadlocks retain their engine codes, and the affected client/office APIs return a safe review/retry response for them. Private database messages are not returned.

The forward migration changes only explicit custom error-code assignments and checks that every other function catalog field and the canonical SQL of default arguments, including owner, grants, execution security and search path, stays identical. Existing SQL regressions require the new exact code while checking rollback, saved receipts, fees and approval gates. A catalog regression checks all seventeen functions and protects anonymous/internal-helper access. Supabase describes the custom-`40001` retry issue in [its current guidance](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b); the live PostgREST version and live retry behavior have not been verified. No live migration or backend termination is part of this change.
