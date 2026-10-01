# Three-role experience completion audit

Updated October 1, 2026. The goal remains incomplete. This audit preserves the full three-role scope and does not treat passing unit tests as proof of product acceptance.

| Requirement | Current evidence | Remaining proof or work |
|---|---|---|
| Executives can find and review appointments | Shared schedule sections, filters, completed-visit review queue and individual visit evidence/invoice inspection; sample browser flow verified | Authenticated records, role isolation, actual exception resolution |
| Executives can interpret costing and follow up with overdue clients | Reporting labels its latest-200-record scope, shows loaded completed visits, and links customer records; build and lint pass | Authenticated reporting with representative costing and overdue records, validated destination links |
| Cleaners can find visits and agreed pay | Daily and full schedules, scoped reads, contractor assignment-pay lookup, employee hourly copy | Authenticated agreed-pay comparison and assignment isolation |
| Cleaners can accept work and recover failures | Offer retry and session recovery; preview failure verified | Test-account acceptance/decline, successful schedule refresh, expired-session recovery |
| Cleaners can finish work and recover photo uploads | Committed IndexedDB writes, revision-safe retakes, shared upload passes, per-visit counts and retry/session recovery; browser reload preservation verified | Physical-phone offline capture, restart, reconnect, uploads and completion |
| Clients can find and understand their visits | Account upcoming filtering, visit sections, exact-room photo updates, canceled recovery and changeable finish estimates; sample phone review verified | Own-record isolation and live stage progression |
| Clients can submit and confirm booking requests | Native field validation, retained edits, explicit request/estimate receipt; browser form progression verified | Non-production submission receipt and failure recovery; confirmed appointment workflow |
| Clients can select an accepted cleaner and handle backup changes | Cleaner directory exists; release document calls it informational | Selection, acceptance and backup confirmation implementation and usability verification |
| Clients can reschedule or skip, and manage preferences | Home-instruction editing published in draft PR #28 under Account, including ownership checks and conflicting-edit review | Deploy the home-instruction migration and verify an authenticated save; rescheduling/skipping rules requested from the user, implementation and acceptance still outstanding |
| Cleaners can manage availability and understand earnings | Working-hours editor and recorded-pay screen published in draft PR #28; pay separates ledger records from assignment amounts and hourly terms | Apply availability migration; verify authenticated saves, representative pay records and full statements |
| Payments, receipt, rating and tips reconcile | Existing automated billing tests and readiness document | Stripe test-mode integration, business approval, authenticated rating/tip flow; no live activation authorized |
| Experience works for actual users in all three roles | Preview interaction checks and automated suites | Task-based usability sessions with executives, cleaners and clients |
| Requested PR delivers the latest changes | PR #26 merged September 30. Draft PR #28 includes schedules, availability, pay, home instructions and photo durability; Executive review commit 6d970c8464d1e44e9cc2ac0e9b4624575f5f7b41 passed both CI jobs | Include accurate client visit tracking, verify exact final commit CI and authenticated acceptance |

## Access and safety boundaries

Both authoritative workspace and verification checkout contain only `.env.example`. The user supplied four account identifiers. Read-only verification in the active Supabase project confirms three authenticated, confirmed accounts spanning admin, cleaner and customer roles; the fourth identifier has no auth record there. Own-record queries succeed, but the cleaner has no assignments and the customer has only one visit, so this does not prove representative acceptance, completion or earnings flows. See the private workspace account-verification report for identifiers; do not publish those identifiers in this audit.

The Vercel preview is deployed for PR #28, but the inspected browser reached its protected sign-in screen. Preview database identity and provider behavior still require confirmation before test mutations. Do not substitute production for a test environment, activate billing or messaging, or claim authenticated browser gates passed from sample data.

The active database has the base payout ledger but lacks the tip columns introduced by existing migration 0028. The pay screen preserves access to work/mileage records and explicitly labels unavailable tip details. This is deployment evidence, not authorization to apply live migrations.

## Follow-up evidence

- Working hours: 1 to 28 same-day windows, split shifts, overlap validation, database-derived cleaner identity, atomic replacement under existing RLS. Empty declarations remain unknown in dispatch; once saved, blank days mean unavailable. Entirely empty schedules are rejected and directed to the office. A browser check confirms edited times persist after removing another row, and the 390px layout has no horizontal overflow.
- Pay: bounded reads for the current cleaner only, recorded paid versus awaiting payment, work/mileage/net-tip reconciliation, Dallas-date filters, employee terms and separate contractor assignment amounts. No payment action exists on this screen. Missing tip data is unknown, not zero. Database errors do not become empty statements.
- Home instructions: linked clients can edit entry, parking, pet notes and gate codes for their own homes under Account. Gate codes are masked by default. A security-invoker RPC applies existing RLS, checks the original instruction values under a row lock, and rejects conflicting changes. A trigger also blocks direct client changes to ownership, addresses and room counts, while preserving existing administrator and trusted-import writes. Failure keeps edits; conflict review offers the latest details or the client's retained draft. No office message is sent by this flow.
- Verification covers calculated amounts, filtering, scoped queries, unauthorized and unlinked profiles, paused-cleaner history, imported zero assignments, failed reads and partial legacy statements. Representative authenticated browser history and live payment reconciliation remain outstanding.
- Final local suite: 1,144 tests pass in both UTC and America/Chicago, with five existing live-service tests skipped. Lint and production webpack build pass. Exact home-instruction migration and SQL regression passed in an isolated PGlite PostgreSQL engine, covering two-client isolation, protected columns, stale conflicts, retries, clearing fields, bounds, role rejection, admin edits and imports. The prior combined-feature commit passed the full PostgreSQL 16 migration and regression CI job. Concurrent availability/home-save connections and authenticated acceptance remain unverified.
- Browser checks verify payment-state filtering, clear-control reset, retained invalid-range dates and empty-result recovery. Home instructions preserve typed fields across code reveal/hide; Account is selected during editing and preview saving is disabled. At 390px both editor and pay page have no horizontal overflow, and all five cleaner navigation targets exceed 44px in each dimension. The pay summary uses recorded amounts only; agreed visit amounts are excluded. Successful authenticated home saving and conflict resolution in the browser remain unverified.

## Next verification sequence

1. Verify the preview's database and provider settings, sign in with the supplied accounts, and supply representative test records in that non-production environment.
2. Run one test visit from request through assignment, cleaner acceptance, start, capture and completion to client status and executive reporting. Confirm whether provider calls are disabled before mutations.
3. Verify rejected/session-expired actions and offline photo recovery on a physical phone.
4. Complete booking/rescheduling/skipping and remaining preferences against agreed product rules, and deploy and verify availability, earnings and home-instruction changes.
5. Conduct role-specific usability tasks and address observed friction.
6. Update the existing draft follow-up PR and verify CI for the exact final commit.

## Cleaner photo durability and recovery

The queue now resolves writes on transaction completion and rejects an abort even after request success. Queue updates and removal compare capture revisions in the same read/write transaction, so settling an older upload cannot remove or overwrite a retake. Legacy records without revisions remain supported. Upload callers share a pass, receive visit-specific counts and use Web Locks to serialize passes across tabs where supported. The queue removes a photo only after the recording endpoint explicitly confirms `recorded: true`; an HTTP 200 or sign-in page alone is insufficient. Manual retry preserves attempt history, applies only to the selected visit and retains bytes on failures. Storage and recording 401s offer sign-in recovery.

Browser review used synthetic photos in an isolated local review screen with no provider credentials. The saved photo survived reload and failed retries. A second visit showed no queued photos from the first. At 390px there was no horizontal overflow and all capture/retry targets were at least 44px high. Synthetic photos and the temporary review route were removed after verification. The screenshot is retained in the private workspace. Automated IndexedDB regressions cover abort after request success, committed bytes, old-upload/retake settlement, legacy queues, rejected and unconfirmed server responses, concurrent callers, scoped retries and recovery after a failed pass.

This does not prove physical-phone offline recovery, storage permission/timeout behavior or successful upload in staging. Uploading resumes while the visit is open; the UI no longer promises that a closed browser will continue uploading.

## Executive visit review

The completed-visit queue lists up to 200 completed visits without an invoice timestamp, placing missing completion dates first and then the oldest finished visits. The overview, schedule and customer history link to an individual visit review. That review separates the current home's required before/after server photo records from issue photos, assigned cleaners, actual visit times and recorded invoice status/balance. It does not infer payment from completion or photo evidence. Both queue and detail refresh automatically while visible and provide manual refresh.

Photo links pass through an administrator-only endpoint using the request-scoped Supabase client and existing row-level security. The endpoint matches both photo and visit, validates the stored visit path, creates a 60-second private storage link, and disables response caching. Signing/read failures return to the detail page with recovery copy and a dismissible message. Private storage paths and signed URLs are not rendered in page markup.

Fifty-four new regressions cover state interpretation, bounded and scoped reads, missing records, failures, actual invoice amounts, role rejection, photo/visit matching, link duration, invalid storage paths and sample page rendering. The full local suite passes 1,092 tests in both time zones; typecheck, lint and production webpack build pass. Browser review confirms missing-photo and invoice-review cases, manual refresh, selected management navigation and a 390px layout without horizontal overflow. The sample records are explicitly labeled and do not open provider photo links.

Read-only checks confirmed the active database's photo, timing and profile-phone columns. This is not proof of authenticated preview access, successful private-photo downloads, live invoice reconciliation or exception resolution by real executives. No database migration, invoice mutation, billing or messaging action was added in this increment.

## Accurate client visit tracking

The client detail reads the visit, all six configured room-count fields, lead assignment and required before/after photo records through the signed-in Supabase client and existing RLS. Progress counts only complete before/after pairs for the current home's exact room keys. Before-only, after-only, issue and extra-room records cannot advance that count. Missing or failed reads produce recovery instead of fabricated zero counts. Photo reads are scoped to this visit and required keys/kinds, with the exact unique-record upper bound; private paths, photos and assignment pay are not selected.

Cancellation takes precedence over historic start times and assignments. Canceled visits show their original appointment and a replacement-request path, with no active-cleaner promise, ETA, progress tracker or rating action. Finished work retains its actual photo count and refresh action, explaining that photos can still be waiting on the cleaner's phone. The screen identifies the visit's home, links its home instructions while active, distinguishes an unavailable cleaner profile from pending matching, and labels finish times as changeable estimates. An elapsed estimate does not imply completion.

Fifty-two new tests cover exact room pairs, all room types, invalid data, cancellation, finished work with missing uploads, scoped and bounded queries, role gates, missing records, ambiguous lead assignments, estimates and page rendering. The full local suite passes 1,144 tests in both time zones; lint, typecheck and production webpack build pass. A temporary local fixture rendered the same production component for in-progress, finished and canceled cases. At 390px there was no horizontal overflow; completed-photo refresh preserved the state. The temporary route was removed before the final tests and build.

Read-only authenticated-role verification confirms the supplied client has one readable visit with all room-count fields, zero required-kind photos and zero lead assignments. This verifies read availability, not active progression, populated-photo isolation, browser sign-in, cleaner acceptance, payment or rating behavior. Representative test records and full three-role acceptance remain necessary.
