# Scheduled work

Two sweeps run on a timer. Both run with no signed-in user, so both are
guarded by `CRON_SECRET` rather than a session — unset, they refuse
everything, which is the right way round to fail.

Times are UTC, because cron is. What they mean locally is the part worth
checking, since the business runs on the America/Chicago calendar.

| Sweep | UTC | Dallas | Why then |
|---|---|---|---|
| `/api/recurring/generate` | 08:00 | 02:00 / 03:00 | Overnight, before anyone looks at the board. The horizon is six weeks, so nothing is urgent — it just needs to have happened by morning. |
| `/api/billing/autocharge` | 14:00 | 08:00 / 09:00 | Business hours, deliberately. A card that declines should decline while somebody is awake to see it, and a customer who gets a failed-payment email should be able to ring someone. |

The one-hour drift in the Dallas column is daylight saving, and it is
tolerable for both: neither depends on a precise local time. Anything that
does must not be scheduled this way.

## Both are safe to run again

Neither sweep assumes it runs exactly once.

**Recurring generation** is idempotent on `(recurring_plan_id,
occurrence_date)`, enforced by a unique index. Running it twice, or three
times concurrently, produces one job per occurrence — asserted against real
Postgres in `verify-migrations.sh`.

**Auto-charge** is idempotent three ways: a deterministic Stripe idempotency
key per (invoice, attempt), a unique constraint on `payments.idempotency_key`,
and a `payment_operations` row that blocks a second attempt on an invoice
someone is already collecting.

So a missed night is nothing to panic about — the next run catches up — and a
double-fire costs nothing.

## Running one by hand

```bash
curl -X POST https://app.heyspotless.com/api/recurring/generate \
  -H "x-cron-secret: $CRON_SECRET"

curl -X POST https://app.heyspotless.com/api/billing/autocharge \
  -H "x-cron-secret: $CRON_SECRET"
```

## Reading the response

`/api/recurring/generate` returns counts, and `problems` only when something
actually went wrong:

```json
{ "plans": 24, "created": 3, "existing": 0, "skipped": 1, "shifted": 0, "failed": 0 }
```

- **created** — new visits put on the board. Usually a handful: the horizon
  means most occurrences were created days ago.
- **skipped** — occurrences somebody called off. Normal.
- **shifted** — a visit moved out of the hour the clocks skip. Rare, and
  worth a look if it is not zero in March.
- **failed** — a plan that could not be generated, listed in `problems` with
  its id. One bad plan does not stop the others, by design, but a non-zero
  count here is a data problem waiting for a person.
