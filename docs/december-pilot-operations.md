# December pilot: office fallback and role handoff

Use this procedure for the proposed December 1–7, 2026 soft transition. It is a rehearsal and operating procedure, **not evidence that the pilot is accepted**. Matt and Maddie must approve the cohort, operational ownership and staffed coverage before real visits move. Codex prepares the release and evidence; Management owns customer commitments and money decisions.

Current release dependencies: [production rehearsal](production-release-rehearsal.md), [authenticated acceptance](preview-acceptance.md), [candidate photo recovery](https://github.com/mattcleans/Heyspotless/blob/cc3e767008afed963a50cf6e2203b3a2fe8f10d2/docs/photo-capture-versioning.md), and [candidate money policy](https://github.com/mattcleans/Heyspotless/blob/c0b83a3af7c33997ce46c8be1b3d75843b543c03/docs/money-policy.md). Invoice issuance described below requires [PR #47](https://github.com/mattcleans/Heyspotless/pull/47) and photo versioning requires [PR #48](https://github.com/mattcleans/Heyspotless/pull/48); their preview deployment does not make them production features.

## Before the first pilot appointment

By November 6, Management confirms the operational source of truth. Existing [setup guidance](setup.md#6-export-from-housecall-pro-then-import) names Housecall Pro, but that document is not confirmation of today's operating practice. Do not import production records or enable recurring generation from that assumption.

For each proposed pilot household, reconcile the customer and home, access instructions, confirmed room scope, service price, extras, recurring frequency and next dates, preferred Cleaner, accepted assignment/pay, and any outstanding balance. Keep access codes and personal details in authorized operational systems, outside Git or this document. Mark inferred historical scope as legacy/unconfirmed and obtain a new agreement before claiming it was confirmed.

Create one private transition register, with one row per appointment:

| Field | Required value |
| --- | --- |
| Identity | Source appointment reference, app visit reference, home reference |
| Appointment | Dallas date/time, current status, latest agreed change |
| Ownership | Exactly one scheduling owner, reminder owner and billing owner; each names a system and responsible person |
| Agreement | Reviewed price/extras, scope confirmation reference, Cleaner and accepted pay reference |
| Recurrence | Series owner, next generated dates, duplicate check result |
| Money | Invoice reference, amount/currency, paid/refunded/outstanding amounts, existing provider request reference if any |
| Exceptions | Action, named owner, due time, outcome and evidence reference |
| Handoff | Reviewer, approval time and effective cutover time; rollback owner |

Do not put a card number, password, recovery link or access code in the register. An appointment without a confirmed owner stays in the established operating process. A copy in the app is not permission for both systems to send reminders, generate recurring visits or issue bills.

Rehearse at least one synthetic appointment and one synthetic recurring series in the isolated preview. Match every scheduled occurrence and balance before/after; explicitly check moved off-cadence dates and the next generation horizon. The existing importer infers plans from history and can activate them; a successful dry run alone does not establish the agreed schedule. Review the existing import procedure and output before separately approving any production import.

## Start and end of each staffed day

Management names a primary office operator and a backup, plus the hours each covers. Confirm the published office number is monitored; a visible phone link alone does not prove someone answers it.

At opening, review the appointment register against `/admin/schedule`, matching exceptions at `/admin/dispatch`, Cleaner requests at `/admin/cleaner-requests`, and `/admin/automation`. For each visit within the next day, confirm the assigned Cleaner has accepted, any backup has the Client's approval, and exactly one person/system owns its reminder. Check unfilled or changed visits first. Include outstanding exceptions from the previous shift.

During coverage, review exceptions at opening, before each imminent appointment, after a reported change/failure, and before handoff. Assign a specific next review time to every unresolved item. Matt and Maddie must confirm that this coverage fits the pilot's actual appointment volume; it is not an automated alert guarantee.

At closing, reconcile completions and remaining photos, issued invoices and uncertain payments, next appointments and recurring dates, and manual contact outcomes. The backup explicitly accepts unresolved items before the primary operator leaves.

## When messaging is unavailable or uncertain

Keep messaging free unless a specific paid option is approved. With app sending disabled, no automated message should be promised. The office uses its already available, authorized communication method after the human operator checks the contact preference and opt-out status. Codex does not contact Clients or Cleaners merely because this procedure exists.

1. Open `/admin/automation` and the relevant `/admin/inbox` conversation. The dashboard samples the latest seven days and up to 500 records; a zero count does not prove there is no older unresolved work or that the scheduler is healthy.
2. Check the appointment register and previous operator's contact record before contacting anyone. A message marked submitted or carrying a provider reference does not establish delivery. A timeout can mean the provider accepted the request; inspect that existing request before sending again.
3. Record an office action with visit reference, purpose, operator, Dallas timestamp, chosen channel, existing provider reference if present, outcome and next review time. Distinguish **not contacted**, **attempted/no answer**, **message left**, and **recipient confirmed**. Do not label a manual call as app/provider delivery.
4. Confirm appointment time, assigned Cleaner and any Client decision directly. An unanswered message is not acceptance of a backup. Keep the visit blocked from starting until the Client approves the actual current backup through the supported workflow.
5. If the recipient cannot be reached, escalate to the named backup operator before the visit. Do not promise an unavailable Cleaner or silently substitute one.

Manual follow-up is tracked in the private register; the current app does not offer a general-purpose manual contact ledger. Restoring provider service requires an explicit ownership handoff and duplicate review. Do not blindly replay old reminder rows or change stored delivery outcomes to make the dashboard look healthy.

## Cleaner quick start and recovery

- Sign in with your Cleaner account on the device you will use. Open the assigned visit and check its address, appointment, saved room list and your own agreed pay. Ask the office about any discrepancy before starting.
- Open and start the visit while connected. A backup approval block must be resolved by the Client; the office cannot treat a phone message left as approval.
- Take before/after photos for the saved rooms. “Saved on this phone” and “waiting to upload” mean local copies remain; they do not mean the office has the photos. Keep the visit open while uploading. Reopen this same visit in the same browser on the same device to resume.
- If sign-in expires, sign in again with the same account and return to the visit. Use **Retry uploads** when offered. Do not clear browser data, switch to private browsing, reinstall, sign into another Cleaner account, or discard the device's copies as a recovery step.
- If storage cannot save a photo, stop treating that capture as saved and call the office. If the assignment changes, leave pending photos intact and ask the office to review access; do not upload them under somebody else's account.
- When connected, **Done** can finish the visit even while photos wait. Completion does not prove uploads succeeded. Tell the office about pending evidence; Management must verify the required current photos before invoice issuance.

Actual iPhone and Android offline/restart/storage/session/reassignment acceptance is still required. A desktop viewport or passing unit test is not a substitute.

## Client quick start and recovery

- Sign in with your own account. Check the saved home and instructions, visit date/time in Dallas, service price and assigned Cleaner. Update home instructions only in your account.
- Review and explicitly approve or decline a proposed backup before work starts. A preference request does not itself change an assignment.
- Review the displayed terms before confirming a schedule change. Appointment-day cancellation, door turnaway, or moving to another date costs $60. Moving to another time on the same appointment day is free; changes before the appointment day are free. Clients may change their recurring schedule.
- After a lost response, reopen the visit and inspect the saved status before trying again. Call the office if the appointment, Cleaner or amount is unclear.
- Pay only an issued invoice through the approved payment process. If a payment spins, times out, or appears duplicated, ask the office to inspect the existing request before another payment. Never send a card number or password in a support message.

## Management review and payment recovery

Review `/admin/review` and the individual visit. Check completion, accepted assignment and pay, saved agreed scope/price, and every required current before/after photo. A completed visit with missing or unverified photos remains an exception. Legacy room scope needs honest review; do not invent an agreement or bypass the evidence gate.

For the approved pilot, Management explicitly reviews and issues each invoice. Check the exact invoice reference, total and Dallas due date in **Review and issue this invoice** before confirming. Issuance makes a bill visible; it does not charge, text or email. Automatic issuance and collection remain off. After an interrupted issuance, refresh that visit and invoice first; verify the saved receipt before deciding to retry.

For uncertain money, open `/admin/payments`. Checking an existing request reads its provider status and can record an already confirmed payment; it does not create another charge or refund. Disabled billing prevents that provider check, so arrange authorized operator review in the existing provider dashboard. Do not mark paid based on a Client screenshot alone, create a new collection request to test a theory, or move an unresolved balance to another system as a new debt. Reconcile provider reference, amount/currency, invoice and refund before resolving it. Any actual charge/refund needs the appropriate authorization.

## Supervised fallback rehearsal — due November 13

Run with synthetic preview data, providers disabled unless separately approved for test mode, and a named office operator. Record the deployed commit/project, visit and relevant receipt IDs, expected result, actual result, operator and timestamp. Use real phones for the device cases. Leave a case **not run** until its evidence exists.

| Case | Required observation |
| --- | --- |
| Reminder unavailable | Operator finds disabled/skipped/overdue work, assigns manual ownership, records a simulated contact outcome, and next shift can identify remaining work. No provider message is falsely claimed. |
| Uncertain delivery | Existing request is inspected before any second contact; recipient confirmation and provider submission remain distinguishable. |
| Cleaner unavailable | Client sees the actual replacement; Start remains blocked before approval and becomes available only after the current assignment is approved. |
| Same booking, interrupted photos | Local captures/retakes survive restart and exact server confirmation clears only the intended revision; Done does not hide pending uploads. Office withholds issuance while required evidence is missing. |
| Uncertain payment | Operator finds the existing request, obtains its confirmed outcome, and reconciles once without a second charge. Test a failed and a delayed successful outcome. |
| Recurrence/change | One owner handles the change; both register and app agree on affected/kept dates and fee; no second generated appointment, reminder or bill appears. |
| Shift handoff | Backup can name every unresolved visit, last action, next deadline and authorized next step without relying on a chat recollection. |

Matt and Maddie review the results before the November 16–20 supervised cohort. An unstaffed fallback, an unapproved backup, an unresolved payment, failed recovery, or unreconciled duplicate blocks that affected visit/cohort from cutover.

## Stop and return to the established process

Management stops adding affected appointments if assignments, evidence or money cannot be reconciled. Preserve records and local captures; identify which scheduled/provider actions may already have happened. The operator confirms a single owner in the established process and records the handoff for each affected visit before resuming any reminder, appointment generation or billing there. Reconcile existing provider requests first. A database restore does not reverse a payment, message or customer promise. Technical rollback follows the separate production runbook and requires its backup/restore gates.

Do not delete records, clear a phone, mass replay messages, bulk import production data, enable paid messaging or activate live collection as a fallback. Those are separate actions requiring their own review and authorization.
