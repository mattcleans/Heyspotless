# Review a visit-change fee

During the pilot, Management reviews and issues every new invoice, including $60 appointment-day cancellation, door-turnaway and rescheduling fees. Moving to another time on the same appointment day remains free; earlier-day changes remain free.

A confirmed paid change saves a draft fee and its original change receipt. It does not create a bill due, charge a card, send a message or alter the agreed service price. Existing issued and paid records retain their history.

From Management’s **Completed visit review**, open **Review cancellation and rescheduling fees**. The list shows unissued fee drafts, oldest first, with pagination. Open a fee, review the Client, saved change, original visit/history and invoice reference, choose the Dallas due date, and explicitly confirm the review before issuing. Fees do not require photos of cleaning work that did not occur. Service invoices retain their separate completion and photo gates.

The server rechecks the saved change, fee amount, ownership, actor, due date and payment state under locks. Successful issuance saves a private receipt and makes the bill available in the Client’s account. A repeated identical request returns that receipt; a stale review cannot rewrite it. Automatic fee collection remains prohibited, including after issuance. The Client pays an issued bill explicitly when checkout is enabled.

If issuance cannot be confirmed, refresh the fee and invoice before doing anything else. Do not ask the Client to pay again or manufacture another fee. Existing uncertain payment/refund cases must be reconciled through payment review first.

The candidate migration is `20261030005014_reviewed_change_fee_issuance.sql`. It changes future fee generation and adds reviewed issuance; it does not rewrite previously issued fees or process payments. Rehearse code/schema rollout together in isolation. Production application still requires the approved release, verified backup/restore and specific migration approval.
