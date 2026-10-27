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

Follow [the preview acceptance setup](preview-acceptance.md) to bind the PR deployment to a verified Supabase development branch and confirmed preview Auth identities. `npm run preview:prepare` produces a private ordered migration/hash manifest, 29 read-only schema/grant probes, disabled-provider environment template and a guarded synthetic fixture. It makes no remote calls. The generated fixture creates a signed-in client/home, a signed-in cleaner with two accepted assignments, a specific backup-approval scenario, appointment-day/advance change examples and three materialized weekly occurrences. Target acknowledgement, fresh-database and confirmed-account checks run before role changes.

The migration verifier now executes the actual generated fixture in its empty disposable database, checks the role records and exact backup approval, and rolls all fixture/schema changes back before the existing price-book and workflow checks. This prepares repeatable acceptance; it does not provision a branch, establish Vercel access or prove browser acceptance. Confirm paid branch organization/cost and deployment protection access before provisioning.


## Stale review conflict responses

Apply `20261002233405_stale_review_http_conflicts.sql` after the recurring editor. Seventeen exact workflow functions now raise `PT409` for stale appointment, fee, assignment, home instruction and recurring-plan reviews. This maps directly to HTTP 409; it avoids treating a business conflict as a database serialization retry. Genuine PostgreSQL serialization failures and deadlocks retain their engine codes, and the affected client/office APIs return a safe review/retry response for them. Private database messages are not returned.

The forward migration changes only explicit custom error-code assignments and checks that every other function catalog field and the canonical SQL of default arguments, including owner, grants, execution security and search path, stays identical. Existing SQL regressions require the new exact code while checking rollback, saved receipts, fees and approval gates. A catalog regression checks all seventeen functions and protects anonymous/internal-helper access. Supabase describes the custom-`40001` retry issue in [its current guidance](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b); the live PostgREST version and live retry behavior have not been verified. No live migration or backend termination is part of this change.


## Cleaner capacity and release gate

Apply `20261002235329_cleaner_capacity_guard.sql` before deploying the capacity-aware offer/employee RPC callers. A private per-cleaner counter serializes assignments across different visits, including crew assistants, assignment transfers and retained visit time changes. Actual row updates make stale Repeatable Read snapshots raise genuine database serialization failures. The mutex table has RLS and no client/server schema usage or table grants; privileged trigger functions alone maintain it. Assignment/job locks retain current choice, accepted pay and exact backup consent rules.

Known appointment windows use a stored positive end or the estimated duration when no valid end is stored. Adjacent endpoints are allowed. Completed/canceled visits release capacity despite retained history, and assignment/cleaner deletion preserves existing cascades. Undated visits do not prove availability; assigning a time later runs the guard. This does not replace driving buffers, working-hour validation, contractor eligibility or the pending crew replacement flow. Existing legacy overlaps require office review; this migration does not automatically rewrite them.

A contractor offer losing capacity is withdrawn with a durable conflict marker, without a decline reason or assignment. Retry returns the same explanation. Expiry is re-read after waiting and uses the actual database clock. Employee writes that lose capacity report an ordinary unfilled result. Both updated app RPCs require the new migration, so an older database cannot silently use unguarded acceptance. Cleaner offer responses use the session's role/identity, never caller pay or cleaner fields. Preview writes are refused before loading an administrator client; wrong-role and unlinked-account states provide sign-in or office help.

The phone treats a capacity conflict as settled, retains controls for genuine transaction retries, and never reports a booking when HTTP status contradicts an accepted payload. Private database messages stay server-side. Before release, verify authenticated cleaner acceptance/withdrawal/retry, adjacent visits, both time-change orders and crew assistant capacity in the isolated preview. SQL regressions exercise assignment/window/release and access rules; separate-connection races run against PostgreSQL 16 in CI. No live migration or booking mutation occurred.

## Cancellation fees require account checkout

Apply `20261003131256_cancellation_fee_checkout.sql` after the quote migration. The current saved-card consent covers clean invoices. Cancellation fees therefore use explicit account checkout, as appointment-day rescheduling fees already do. A database trigger pauses every fee linked to a cancellation receipt, including fees created after office reconciliation and existing fee invoices. Clearing that pause cannot enable automatic charging; a payment-operation guard also rejects new cancellation-fee autocharge operations. Existing paid amounts, refunds and provider receipts stay intact. The sweep excludes paused invoices before its candidate limit, leaving room for collectible clean invoices.

The confirmed policy remains $60 for appointment-day cancellations, door turnaways and appointment-day rescheduling to another Dallas date. A change to another time that same day is free. Earlier-day changes are free. Scheduling confirmation creates the obligation; payment requires the separate account checkout action.

Disposable PostgreSQL checks exercise cancellation before collection, collection before cancellation, confirmation/reconciliation retries, actual expiry during a wait and genuine Repeatable Read rollback. An in-flight payment holds the fee for office reconciliation instead of inventing a payment outcome or collecting twice. Authenticated preview checkout and Stripe test-mode acceptance still require verification before billing activation.

## Reopen started work without signal

An authenticated cleaner's opened, started visit saves a minimal room checklist and previously confirmed photo pairs on that device. The app prepares a static recovery screen without requesting notification permission. When a full cleaner navigation cannot reach the network, the worker serves that screen; live pages, API responses, dispatch boards, client identities, home access details and pay are never cached. A failed HTTP authorization or server error is returned directly rather than replaced with earlier work.

The screen shows the saved Dallas visit time and last check, warns that the assignment may have changed, and permits durable before/after captures only for an already-started checklist checked within the last day. It cannot start or finish work, send messages, accept offers or charge a card. Reopening the live visit requires current server authorization and resumes the ordinary upload queue. New captures carry the verified cleaner identity; another signed-in profile cannot display or upload those queued bytes. A sign-out or profile change clears checklist visibility while retaining unconfirmed photos. Original version-one photo queues remain intact; unowned legacy bytes are recovered through the existing authenticated online flow and are not displayed in the static recovery screen.

Tests cover the real IndexedDB upgrade, committed writes, expiry, cross-profile changes, rejected stale-page writes, preserving queued bytes and acknowledging only the current retake. Worker tests execute the production worker and verify navigation scope, authorization responses, sign-out ordering and fallback. A fictional browser checklist reopened with the local server stopped; a test photo survived another cold reload. At 320/390px there is no horizontal overflow and all capture controls are at least 44px high. Physical-phone restart, production storage behavior and authenticated preview acceptance remain release requirements.


## Unconfirmed and delayed payment recovery

Apply `20261020201939_preserve_unresolved_payment_claims.sql` after the reviewed-collection balance guard. A local request deadline does not close a collection attempt. Open operations remain visible to reconciliation and hold the automatic sweep until a provider-confirmed outcome is recorded. Missing provider identity, lookup failure and creation-response loss require payment review; they do not authorize another collection. No historical operation rows are rewritten by this migration.

A completed Checkout session can still have a pending payment. Its attached intent is checked before recording money or releasing the invoice. Paid receipts require an immutable intent ID and a positive whole-cent received amount. Unknown provider states stay unresolved; an expired session or a confirmed terminal intent can release the attempt. Delayed intent-success webhooks can match the captured intent back to the saved Checkout session using a read-only provider lookup, with idempotent webhook retry if that association cannot yet be confirmed.

After a confirmed terminal Checkout, the locked claim assigns a fresh retry generation. Concurrent tabs share that generation; the browser route uses the returned key for both provider creation and attachment. An existing page is resumed only when it still matches the Client's reviewed current bill. Recording a payment asks the Client to refresh Account instead of claiming the entire bill is settled, since a partial payment can leave a balance.

The regressions cover provider status mapping, unconfirmed requests, expired unresolved claims, repeatable retry generations and concurrent tabs. They use simulated provider responses and disposable ledger fixtures. Authenticated sandbox acceptance, bank-delay timing, operator resolution of requests with no saved provider identity, background reconciliation of stalled automatic attempts, retiring obsolete provider pages after an office bill adjustment, and real-phone recovery remain launch checks.


Client payment recovery now disables another Pay attempt while a previous request needs confirmation. The notice offers a full Account refresh for a changed bill, recorded payment, processing request or lost response; a sign-in link for an expired session; or the office phone link for provider review. Add/replace-card failures use the same accessible notice. Network waits, including response-body reads, have the existing two-minute deadline and never automatically resubmit a write. Recovery targets are at least 44px tall.

Twelve focused transport/notice tests cover those recovery paths, uncertain JSON/network outcomes, preserved reviewed balance, a confirmed reused session, stalled-body timeout and hidden server diagnostics. A clearly labeled local 390px browser fixture verified disabled Pay, office/Account links, a 44px recovery target and no horizontal overflow. This is synthetic UI evidence, not authenticated provider or physical-phone acceptance; the temporary fixture and mocked endpoint were removed.


### Management payment review

Management navigation and Automation link to `/admin/payments`. The oldest-first, paginated queue shows open and historically abandoned requests, Client/visit links, requested amount separately from the current invoice balance, Dallas request time and expandable Stripe/request references. Missing receipts and elapsed local deadlines remain unresolved. Read failures do not become a reassuring zero count.

`POST /api/billing/reconcile` requires a signed-in Management profile and a current invoice read before creating a privileged billing writer. Demo mode and disabled billing refuse status checks. It calls only the existing reconciliation path, which reads existing provider objects and records a confirmed capture idempotently; it never creates a payment, session, refund or transfer. Unknown outcomes stay on hold. Partial/recovered payments ask staff to review the current balance rather than declaring the bill paid. The queue itself reads using the signed-in Supabase client and its RLS.

Twenty-one focused route/page/render tests pass. The rollback-only payment-review access probe passed on isolated PostgreSQL17: Management sees both linked fixtures, each Client only their own, Cleaner and anonymous none. No fixture Auth users or requests remain. CI runs the same probe after fresh migrations. Local synthetic desktop/390px/320px interactions verified persistent status feedback, expandable references,44px status target and no horizontal overflow. These are not signed-in deployed or live-provider proofs.

Requests with no provider identity and historical abandoned requests still require Stripe investigation and a verified resolution workflow. This screen provides visibility and status reconciliation, not an unchecked manual release. No production deployment or provider action is part of this change. Migration20261026032542 explicitly grants authenticated SELECT on the three RLS-protected linked tables, matching the existing hosted read contract. It changes no write permissions or rows. The first fresh-database CI failed because the hosted default grants were absent, while hosted role tests had passed. The migration guards RLS before granting reads.


### Cleaner arrival-text receipts

The On my way endpoint no longer treats a dedupe conflict as proof that the Client received a text. It reads the saved receipt for the current assigned Cleaner and visit. Provider acceptance is labeled Text submitted, with delivery explicitly unconfirmed; pending or failed records remain unconfirmed. GET reads recover the saved state after reload or a lost POST response without creating another send. Both browser fetch/body waits are bounded. The Cleaner has a status-check action and office/sign-in/visit-refresh recovery, replacing the unsupported claim that the Client knows or has not been told. Legacy delivered_at values are deliberately not treated as carrier-delivery evidence.

Fresh POST requests verify Cleaner role, current ownership, assigned visit status, backup approval, contact eligibility and messaging activation before claiming a request. A conflicting claim with no readable current-Cleaner receipt stays unconfirmed. Raw provider diagnostics remain internal. The existing one-per-visit claim remains; there is no automatic resend or manual-release action.

Two false-success regressions first failed against the old route. Twenty new receipt/transport/API/render tests and eight existing Cleaner access tests now pass, plus type checking and targeted lint. A synthetic local browser check recovered an uncertain response through GET, retained Text submitted after full reload and produced exactly one POST in server logs. At390px the status target was46px and document width390, with no overflow. No SMS/provider call occurred; fixture, stub and cache were removed and server stopped. Signed-in deployed and handset/provider delivery acceptance remain unproven.

Free Twilio test-credential access could not be established through the accessible new console, which exposes only live credentials. Current official docs say new-console test credentials cannot be created and only existing legacy credentials continue to work (https://www.twilio.com/docs/iam/test-credentials). No credentials were revealed, copied, generated or used; no number was purchased and messaging activation stayed unchanged. Actual carrier delivery, callbacks, and older message records elsewhere in the app still require launch verification.


The Management inbox now reads SMS provider references and recorded failures through its signed-in RLS client. Outgoing SMS bubbles distinguish submitted/delivery-unconfirmed from delivery-unconfirmed/needs-review, with expandable reference/error details for office investigation. Incoming and non-SMS records do not get outgoing SMS labels. An explicit Management role check precedes the inbox read. Nine additional render/access tests pass; the combined focused suite is50 tests (29 new,21 existing). A390px synthetic office check verified both states, expandable missing-receipt details and no horizontal overflow. This adds request visibility; it does not manufacture carrier-delivery receipts or settle unknown messages automatically.


### Verified photo receipts and invoice evidence

The photo recorder now locks the visit and verifies the current assignment, active service status, current required room key, canonical slot path and an existing private job-photos object before returning a receipt. Invalid requests raise errors, so older API code cannot silently acknowledge a rejected write. Replays preserve their receipt, including issue photos. A valid replacement can repair a legacy noncanonical slot pointer. Direct authenticated photo writes are revoked; signed-in reads retain RLS and service writes remain available. No historical row is rewritten by applying the migration.

The service-invoice gate checks each exact before/after room slot and its matching stored object, rather than counting arbitrary paired room names or database metadata alone. It serializes by visit, preserves an existing unambiguous service bill, does not substitute rescheduling fees, refuses blind replacement of voided/ambiguous records and retains the agreed job price and draft status. Completion is still independent from missing photos.

The photo API refuses missing/uncertain receipts, restricts Cleaner role and uses the home's full room configuration for outstanding requirements. The browser queue keeps its bytes until a server receipt identifies the exact visit, room, kind, storage path and photo ID. Old boolean-only or mismatched acknowledgements cannot discard the local copy.

A rollback-only isolated probe reproduced the prior gate creating an invoice from arbitrary room keys without uploaded objects; no probe customer remained. New SQL checks model object metadata explicitly, with no image uploads, and cover assignment/path/room/object denial, exact-slot billing, stable retries and draft price. Existing positive completion fixtures now provide canonical object catalog receipts. Node photo/API/queue/service tests and shell syntax checks pass. Final database CI and hosted after-migration checks remain required.

This patch does not issue or collect invoices. Missing legacy draft recovery and the policy for issuing bills remain open, along with scope snapshots if home room counts change after work and actual handset retake/reassignment acceptance.
