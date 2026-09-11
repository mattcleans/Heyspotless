# Money policy

What the system does with money, stated once, in the language of the business
rather than of the schema. Every rule here is enforced in SQL and asserted in
`scripts/verify-migrations.sh`; where a rule and the code disagree, the code
is wrong.

Two questions get confused constantly, and keeping them apart is what most of
this document is for:

1. **What did we take, and what did we give back?** — reporting. Gross
   figures. Never adjusted after the fact.
2. **What does the customer still owe?** — collection. What the auto-charge
   sweep acts on.

## The invoice, in six numbers

```
subtotal    the work, from the price book
tip         added at payment; folded into the total
total       subtotal + tip — what the job was worth
paid        gross successfully captured, ever
refunded    gross returned to the customer, ever
credits     what we have decided not to collect

balance = total - credits - paid + refunded
netPaid = paid - refunded
```

`balance` is a generated column. `lib/billing/amounts.ts` implements the same
expression, and the two are asserted against each other. Nothing recomputes
it by hand.

## Refunds

A refund is cash going back. Whether that cash becomes owed again is a
**separate decision**, and it has to be stated — a goodwill gesture and a
correction are the same Stripe call and opposite outcomes for the customer.
`POST /api/billing/refund` therefore requires `kind` and has no default.

| Kind | Credit raised? | Balance after | Use it when |
|---|---|---|---|
| `unattributed` | yes, matching, **split 50/50** | unchanged | Nobody said why. The default. |
| `service_refund` | yes, matching | unchanged | The clean was the problem, and someone has confirmed it. |
| `goodwill` | yes, matching | unchanged | The work was fine and we chose to give something back. |
| `overpayment` | no | rises to zero, never past it | They paid more than was owed and we are returning the difference. Capped at what was actually overpaid. |
| `correction` | no | restored, collectible again | The money is still owed; it was taken the wrong way (wrong card, wrong customer). We intend to collect it again. |
| `dispute` | no | restored, collection **paused** | The customer has disputed. A person handles it; nothing automatic touches the card. |

**`unattributed` is the default** — for refunds issued from the Stripe
dashboard, and anywhere else intent is not stated. A refund of unknown intent
must never turn itself into a fresh charge, so it is credited in full.

### Why an unexplained refund is not all goodwill

It is fully credited either way, so this changes no money. What it changes is
what the business can see.

Filing every unexplained refund under "goodwill" says the work was fine and we
were being generous. Some of them are. Some of them are a clean that went
wrong and nobody wrote it down — and if the books never say so, nobody ever
finds out which cleans, or which cleaners, or which properties. For a
marketplace that sells trust, that number is not a footnote.

So an unattributed refund is split **50/50** between `service_refund` and
`goodwill`: a stated default in the absence of better information, not a
measurement. The odd cent goes to goodwill, because understating a clean's
failures is safer than pointing quality work at the wrong job.

`service_refund` is also selectable outright, for when someone looked and
knows. That one is undiluted — it is the figure quality work should be
prioritised from, so guesses must not inflate it.

The share lives in one place in each language: `unattributed_service_share()`
in `0013`, and `UNATTRIBUTED_SERVICE_SHARE` in `lib/billing/types.ts`. Change
both when there is real data on how often an unexplained refund turns out to
be a service failure.

### The worked example

$170 clean, paid in full, $50 back as a goodwill gesture:

```
total 17000, credits 5000, paid 17000, refunded 5000
balance   0        nothing outstanding, nothing to charge
netPaid   12000    $120 retained
total     17000    still the value of the job, for job costing
```

Before this distinction existed, that $50 became $50 owed — and with autopay
on, the sweep took it straight back off the customer's card. The apology
became a second charge.

### A refund is not final when it is created

Stripe can accept a refund and fail it days later when the issuer rejects it.
A refund may be recorded `pending`; only a `succeeded` one moves any money
here. `refund.updated` / `refund.failed` settle it. A replayed settlement is
a no-op.

### Credits without refunds

`record_invoice_credit` stands alone: a discount agreed after the fact is a
credit with no cash behind it. Same effect on what is owed, no Stripe call.

## Collecting

**Each obligation is collected at most once.** The mechanism is
`payment_operations` (0012): a row written *before* Stripe is called, and at
most one open per invoice — enforced by a partial unique index, decided under
a lock on the invoice row.

| Situation | What happens |
|---|---|
| Two Checkout tabs, same balance | Same idempotency key; the second gets the **first tab's session**. One chargeable page. |
| A second click after the first finished | The key is already resolved. No new attempt. |
| Customer in Checkout while the sweep runs | The sweep skips the invoice (`collection_in_flight`). |
| Sweep charging while the customer clicks Pay | Checkout refuses with a message, not a second charge. |
| The process died before Stripe was called | The attempt expires and releases the invoice. No money can have moved. |

### The uncertain outcome

**A decline is not the same as not knowing.** If Stripe succeeded but the
response was lost, or the process died before the write, the invoice still
reads as unpaid — and a retry takes the same money again.

So before starting any collection, we ask Stripe what became of anything
already open:

- **paid** → record it (idempotent on the payment intent) and do not charge.
- **still open** → join it, or refuse. Never start a second.
- **dead, no money moved** → clear it; collecting is safe.
- **Stripe unreachable** → the outcome stays unknown, the attempt stays open.
  This is *not* permission to charge again.

The auto-charge sweep applies the same distinction to its own errors: a
`StripeCardError` is a decline (spend an attempt, schedule a retry); a
timeout or dropped connection is unresolved (leave the attempt open,
reconcile next sweep). The sweep reports `failed` and `unresolved`
separately, and they mean different things.

## Autopay

Consent is two halves — the flag and the timestamp — and a CHECK constraint
refuses one without the other. A card on file is not consent to charge it.

When the last saved card is removed, **consent is withdrawn**: autopay is
switched off, `autopay_authorized_at` is cleared, and the reason is recorded
on the customer so the screen can say "we switched this off because…" rather
than a bare "Off". Saving a card later does **not** resurrect it — turning
autopay back on is a fresh decision the customer makes, which writes a fresh
consent timestamp.

An authorisation to charge a card the customer has since removed is a stale
authorisation, and "they agreed months ago, before they deleted the card" is
not a position to defend a dispute from. Detaching a non-last default still
just promotes the oldest remaining card; consent is untouched there, because
the customer still has a card on file.

The sweep never charges:

- without both halves of consent;
- before the due date, judged on the **America/Chicago** calendar;
- while a collection attempt is open;
- while collection is paused on that invoice (a dispute);
- more than four times, after which a person picks it up.

## Dates

A **scheduled start** is an instant, resolved in America/Chicago and stored
as UTC. A **due date** is a calendar day with no time of day, compared
against today-in-Chicago and never against a timestamp. See
`src/lib/time/zone.ts`; the distinction is why an invoice due today no longer
falls overdue at 7pm the previous evening.

## What this does not cover

- **Recurring plans.** Booking with a recurring frequency prices *one* clean
  at the recurring rate. It does not generate the series. See the README.
- **Partial capture, disputes as a workflow, payouts to cleaners.** Not built.
