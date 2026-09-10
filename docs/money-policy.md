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
| `goodwill` | yes, matching | unchanged | The work stands and we are giving money back — a missed room, a late arrival, an apology. |
| `overpayment` | no | rises to zero, never past it | They paid more than was owed and we are returning the difference. Capped at what was actually overpaid. |
| `correction` | no | restored, collectible again | The money is still owed; it was taken the wrong way (wrong card, wrong customer). We intend to collect it again. |
| `dispute` | no | restored, collection **paused** | The customer has disputed. A person handles it; nothing automatic touches the card. |

**`goodwill` is the default** — for refunds issued from the Stripe dashboard,
and anywhere else intent is not stated. A refund of unknown intent must never
turn itself into a fresh charge.

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

When the last saved card is removed, autopay is **suspended, not cancelled**:
consent stands, the reason is recorded on the customer, the customer screen
says "Paused" and what to do, and saving any card resumes it without asking
again. Detaching a non-last default promotes the oldest remaining card.

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
