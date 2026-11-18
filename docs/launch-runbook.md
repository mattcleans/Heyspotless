# The road to the December pilot

Target the first supervised visits for November 16–20 and the soft transition for December 1–7, 2026. Matt and Maddie select the participants and release each appointment after reconciliation. As of November 18, the office rehearsal and participant approval are pending. Keep scheduling those visits in Housecall Pro until the office records a handoff.

Vercel identifies main commit `eb6e603` as Current Production. It includes the Next.js 16.4.1 patch, the app branding and the reporting changes. Use the protected `GET /api/health` for the deployed commit, configuration flags and database readiness. The public response checks liveness. For scheduler results use Management → Automation. For delivery, inspect the provider receipt.

## A. Accounts and wiring

- **Sign-in email.** Production Supabase has custom SMTP enabled with Resend on port 465 and the sender name Hey Spotless, verified November 18. Matt confirmed that production password recovery works for his Management account. Existing test accounts can continue password sign-in during setup. [Custom SMTP](setup.md#custom-smtp-without-upgrading-the-preview-database)
- **Stripe.** Use the existing Hey Spotless Stripe account. Verify its legal business details against the current registration before live activation. Verify the sandbox keys, webhook signing secret and eight event subscriptions on the isolated preview. The November 14 Management screen showed app billing enabled. The matching worker has billing disabled. Check the deployed app’s billing and automatic collection settings before moving a balance. [Stripe setup](setup.md#2-stripe)
- **Twilio.** Matt reports that the campaign is approved and its A2P registration uses the previous business name. Have the account owner verify the current legal name against the EIN registration and reconcile the brand in Twilio before relying on carrier delivery. Verify the credentials, Messaging Service, inbound webhook and Advanced Opt-Out. Keep messaging free for this pilot. The staffed reminder process is available while SMS delivery is pending. [Twilio setup](setup.md)
- **Web Push.** Check for an existing VAPID key pair before generating one. Verify subscription and delivery on a consenting tester’s phone. [Web Push setup](setup.md#11-web-push--optional-and-the-cheapest-thing-on-this-page)
- **Matching.** Production already retries every five minutes. On November 18 all 288 scheduled runs in the preceding 24 hours succeeded. Review unfilled visits in Automation. [Matching worker](matching-worker.md)

## B. Stripe test mode

The original new-Client booking has one successful $199 sandbox payment and a zero balance. Its saved home, confirmed booking, accepted $65.67 offer, assignment, room scope, 14 version-matched photos and Management-issued invoice still reconcile. The Client chose no preferred Cleaner on this booking. Client approval before starting with a backup was exercised on a separate recurring visit.

Sandbox provider and database tests also covered a decline, capture, tips, refunds, replay and uncertain-payment recovery. Finish the hosted delivery checks for outstanding refund and redelivery cases. For the proposed off-session decline case, verify that each failure schedules the next attempt 1, 3 and then 7 days later, with office escalation after the fourth attempt. Check that a settled or unresolved payment prevents another collection. Record the result at each step. Management reviews and issues each pilot invoice manually. Automatic issuance and collection stay off. Live payment activation requires a separate decision. [Billing setup](setup.md#2-stripe) · [Money policy](money-policy.md)

## C. Reconcile Housecall Pro before transfer

Export customers, homes, jobs and rates to restricted storage. Compare recurring dates, arrival windows, scope, access instructions, Cleaner assignment and agreed pay against the office record. Dry-run the importer, resolve ambiguous matches and review the recurring price audit. Record inferred scope as provisional until confirmed.

The December preparation list contains six appointments and four assigned employees. Resolve the December 3 shared-Cleaner overlap. Keep the separate $119 legacy invoice with Housecall Pro. For each proposed transfer, record a single owner for the appointment, reminders and billing. Rehearse the selected records in isolation, recheck edits since export and obtain office approval before writing production data. Housecall Pro continues to operate every visit and balance it still owns. [Import and pricing guide](setup.md) · [Pilot operations](december-pilot-operations.md)

## D. People acceptance on real devices

- Use the existing Management, Cleaner and Client test accounts. Matt and Maddie rehearse matching exceptions, backup approval, cancellations, missing photos, invoice recovery and uncertain payments in the protected preview.
- On iPhone Safari, offline capture survived closing and reopening Safari, and the server received the photo after reconnection. Confirm that an online reload still shows the photo with zero pending. Run the Android Chrome test on a physical device. Cover interrupted upload, expired sign-in, storage limits and reassignment on both platforms.
- Have selected Clients and Cleaners complete an actual supervised visit and reconcile its appointment, photos, invoice and receipt. Obtain each Cleaner’s profile publication decision. [Cleaner profiles](cleaner-profiles.md)
- Matt owns office reminders and exception follow-up. Name the backup and record coverage. If SMS is used, test delivery, inbound reply and STOP with an authorized tester before customer use. [Office fallback](december-pilot-operations.md)

## E. Business decisions

Matt and Maddie approve the cohort, coverage and ownership register. Clients approve a backup before work starts and may change recurrence. Appointment-day cancellations, door turnaways and appointment-day moves to another date cost $60. Moving to another time that day is free, as are changes before the appointment day.

Review the money-policy examples, Texas worker classification, insurance coverage and drive-time questions with the appropriate advisers. Confirm rotation of the previously reported exposed Housecall Pro token with its account owner. [Money policy](money-policy.md) · [Setup and credential rotation](setup.md)

## F. Start the soft transition

During November 23–30 resolve pilot issues, reconcile the upcoming schedules, finish training and freeze the launch version. Start the December 1–7 transition with the approved cohort. Reconcile visits, reminders and balances daily. If coverage fails or ownership is unclear, hold the next transfer and reconcile the open visit with Housecall Pro. Matt reviews interventions per 100 cleans, escalated pairings and time to fill new recurring visits in Management → Reporting. [Pilot operating procedure](december-pilot-operations.md)

## App stores

Use the installed web app for the pilot. Revisit native store listings after the supervised visits identify a requirement for them.
