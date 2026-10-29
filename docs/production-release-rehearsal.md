# December production release rehearsal

Status: draft procedure, not permission to deploy. Baseline source: a20d80914ddf10620d89332f98105304d62b1951. The December launch checklist maintained with Matt is the acceptance tracker; this document describes the schema rollout and its evidence requirements.

Matt confirmed on October 28 that Management reviews and issues pilot invoices manually. Automatic issuance and automatic collection remain off. This does not authorize live billing, customer communications, production data changes, new charges or reduced security.

## Verified baseline

The isolated preview has 69 migration receipts matching complete source files exactly, plus one separate preview-worker receipt. It lacks the new unconfirmed-payment release migration. Production has 58 receipts against 70 source files. Only two production receipts retain an exact complete-file fingerprint; most older receipts have null/empty or split statement history. That is incomplete provenance, not proof that 56 migrations are wrong. Never replay these historical migrations or rewrite their receipts merely to make hashes match.

Read-only production capability checks establish that Client feedback/feedback-once, reviewed payment claiming, reviewed service-draft preparation, and unconfirmed-payment release routines are absent. The feedback receipt table and both saved room-scope tables are absent. This is an installed capability gap as well as a receipt gap. Preserve the raw catalog observations and source hashes privately with the launch evidence; do not publish customer data, credentials or database dumps.

Public `/api/health` returns liveness only. Deployment identity, database wiring, billing/message flags and scheduler authentication require the protected health response or equivalent authenticated deployment evidence. A successful public response does not pass this gate.

## Ordered source migrations requiring rollout review

Use the exact files from the pinned candidate; compare against fresh production receipts and catalog observations immediately before deployment. If an object is already installed without a receipt, stop and establish its exact definition before choosing an approved repair. Do not blindly apply `CREATE FUNCTION` again.

| Order | Source file | Effect to review |
|---|---|---|
| 1 | 20261020141223_capacity_assignment_filter_before_window.sql | Restricts competing capacity-window validation to the relevant Cleaner assignments |
| 2 | 20261020143449_atomic_client_rating_and_tip.sql | Service-only atomic feedback/tip routine; failed tips preserve the rating |
| 3 | 20261020144211_client_feedback_submission_receipts.sql | Private receipt table and idempotent feedback wrapper |
| 4 | 20261020193216_protect_existing_feedback_and_settled_tips.sql | Preserves omitted public comments and prevents settled payout-tip replacement |
| 5 | 20261020195337_recheck_collection_balance_under_lock.sql | Checks reviewed balance/owner under the invoice lock |
| 6 | 20261020201939_preserve_unresolved_payment_claims.sql | Retains unknown payment claims until a confirmed outcome; no historical payment-row rewrite |
| 7 | 20261026032542_payment_review_read_permissions.sql | Grants signed-in SELECT only after verifying RLS on all linked tables |
| 8 | 20261026042459_verified_photo_invoice_gate.sql | Validates assignment, exact photo slots and objects; revokes direct signed-in photo writes; drafts only |
| 9 | 20261026135602_current_photo_objects.sql | Excludes archived objects and delete markers from evidence |
| 10 | 20261026141004_reviewed_service_draft.sql | Service-only draft preparation checks the reviewed price under the visit lock |
| 11 | 20261026144405_saved_visit_room_scope.sql | Adds read-only plan/visit scopes, creation/finalization triggers and scope-based evidence/pricing; backfills new scope rows |
| 12 | 20261027220000_release_unconfirmed_payment_claims.sql | Service-only Management release after the office confirms no Stripe charge; records the actor, refuses recent/open referenced claims and spends autocharge attempt keys |

Installing function definitions does not exercise their future payment/tip effects. Scope backfill writes new snapshot rows and must be included explicitly in production approval. Missing historical agreements must remain labeled as setup baselines; do not invent confirmed terms.

## Rehearsal before approval

1. Recheck candidate SHA, source-file hashes, dependency lock, current database receipts and installed object capabilities. Preserve the preview-worker receipt. Capture security-advisor baseline and review each finding by actual exposure.
2. Run application checks in UTC and America/Chicago, lint, typecheck and production build. Record the build mode and warnings. Independently run the actual packaged matching worker's Deno check.
3. Apply all source migrations to an empty disposable PostgreSQL database and run the complete CI SQL suite, including concurrent feedback, reviewed balance, unresolved/released claims, photo evidence, draft races, scope capture and role-access tests. An empty-database pass is not an upgrade-from-production rehearsal.
4. In isolated preview, inspect the existing schema/advisors, apply only the missing candidate migration after review, and run its actual rollback-only regression. No real provider calls, image uploads or persistent invoices are needed for this SQL rehearsal.
5. Verify source-matching migration receipts, read-only scope grants, service-only privileged routines, and zero disposable fixtures afterward. Exercise the same-booking authenticated journey separately; do not turn synthetic SQL results into browser/provider acceptance.
6. Establish a verified production backup and demonstrate restoration into an isolated target. Protect credentials and customer data. If the current plan cannot supply a usable backup/restore path, resolve that gap before proposing production rollout. Do not purchase an upgrade without specific approval.
7. Rehearse the upgrade against an isolated reconstruction of the relevant production schema and constraints. Legacy receipt fingerprints alone cannot establish that the baseline matches source. Record any unsupported reconstruction/restore limitation explicitly.

## Production execution — approval required

Before requesting approval, provide the pinned candidate, exact ordered migration hashes, confirmed backfill scope, rehearsal results, backup/restore evidence, release-window owner and rollback/recovery procedure. Reuse prior approvals only where their exact scope still applies; a newly expanded twelve-migration bundle is not automatically covered by approval of a smaller earlier fix.

During the approved window:

1. Confirm the actual deployed SHA/environment and provider flags. Keep automatic issuance and automatic collection off. Quiesce affected background jobs and booking/payment/photo writes using a reviewed operational procedure; do not silently interrupt active visits or weaken authentication.
2. Take and verify the approved backup immediately before changes. Capture aggregate reconciliation baselines and installed routine/permission fingerprints.
3. Apply the reviewed missing migrations in order, retaining accurate per-migration history and transaction outcomes. Stop at the first failure. Do not continue to later files or repair history by guessing. Align a generated receipt version only after exact complete-source equality, unique receipt and vacant target-version checks.
4. Verify schema, ACL/RLS, expected scope provenance and row counts. Existing appointments, prices, assignments, photo objects, invoice totals and payment balances must reconcile. Do not run synthetic mutation tests against production without their own approved scope.
5. Deploy or verify the matching application candidate. Earn protected health, login and role-workspace checks. Confirm scheduled jobs target the intended environment and cannot call providers while their flags are off.
6. Restore only the explicitly approved jobs/flags after checks pass. Live payments and customer messaging remain separate decisions. Record business and technical sign-off in the launch checklist.

## Recovery

On failure, stop affected writes and preserve diagnostics privately. Do not drop the new feedback/scope tables or downgrade payment guards to make an old app appear healthy. These changes preserve evidence and financial safety; code-only rollback may be incompatible with the installed schema.

Use the rehearsed compatible application rollback or reviewed forward repair. Database restore requires the verified restore procedure plus reconciliation of any writes since backup and explicit business approval. Restore alone cannot undo a Stripe charge or delivered message. Unknown provider outcomes must stay held until reconciled; an elapsed local deadline is not proof that no charge occurred.

Reopen all impacted acceptance gates after recovery. The release is ready only when deployed behavior, data reconciliation, scheduler/provider configuration, real-phone recovery and the approved pilot journey have evidence. This runbook and passing CI do not establish launch completion.
