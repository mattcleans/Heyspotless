# Scheduled work

Three sweeps run on a timer. All run with no signed-in user, so all are
guarded by `CRON_SECRET` rather than a session — unset, they refuse
everything, which is the right way round to fail.

Times are UTC, because cron is. What they mean locally is the part worth
checking, since the business runs on the America/Chicago calendar.

| Sweep | UTC | Dallas | Why then |
|---|---|---|---|
| `/api/recurring/generate` | 08:00 | 02:00 / 03:00 | Overnight, before anyone looks at the board. The horizon is six weeks, so nothing is urgent — it just needs to have happened by morning. |
| `/api/dispatch/run` | :30 hourly | :30 hourly | Hourly, not daily. An offer ladder whose next rung waits until tomorrow is not a ladder, and an exclusive hold that lapses at 10am must be noticed before the afternoon. At :30 so the day's new visits from the 08:00 generation are already on the board. |
| `/api/billing/autocharge` | 14:00 | 08:00 / 09:00 | Business hours, deliberately. A card that declines should decline while somebody is awake to see it, and a customer who gets a failed-payment email should be able to ring someone. |

The one-hour drift in the Dallas column is daylight saving, and it is
tolerable for all three: none depends on a precise local time. Anything that
does must not be scheduled this way.

## All three are safe to run again

No sweep assumes it runs exactly once.

**Recurring generation** is idempotent on `(recurring_plan_id,
occurrence_date)`, enforced by a unique index. Running it twice, or three
times concurrently, produces one job per occurrence — asserted against real
Postgres in `verify-migrations.sh`.

**Dispatch** writes at most one live offer per (job, cleaner): `record_offer`
returns the existing offer rather than a second one she could accept twice,
and a job that already has an assignment is left alone. A sweep landing on the
same job as the previous one re-presents what is already out rather than
starting again.

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

curl -X POST https://app.heyspotless.com/api/dispatch/run \
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


## Reading the dispatch response

```json
{ "jobs": 18, "expiredOffers": 2, "assigned": 4, "held": 3,
  "offered": 9, "refused": 0, "unfilled": 1, "failed": 0 }
```

- **held** — visits being kept for the cleaner who already has that customer,
  offered to her alone with a countdown. This number going to zero on a book
  full of recurring customers means continuity has stopped working, and is
  worth a look long before anybody complains.
- **assigned** — W-2 cleaners scheduled directly. An employee is scheduled,
  not asked; only contractors are offered work.
- **offered** — offers written to the board or the first waterfall rung. Only
  the first rung goes out per sweep: writing the whole ladder at once would
  put the highest payout on a cleaner's screen immediately and give away the
  entire benefit of escalating.
- **refused** — offers the database declined because the cleaner stopped being
  eligible between the roster being read and the offer being written, usually
  because she took something else in the meantime. A few is normal on a busy
  board. Persistently many means the sweep is working from a stale roster.
- **expiredOffers** — countdowns that ran out before this sweep. A persistently
  large number means offers are being ignored, not that the sweep is broken.
- **unfilled** — visits no eligible cleaner could take. This is the line the
  admin exception queue should be built from: it is the one case that always
  needs a person.
- **failed** — listed in `problems` with the job id. One bad visit does not
  stop the board.
