-- ============================================================================
-- 0010 — webhook events: completed, processing, or abandoned
--
-- 0006 gave `stripe_events` a primary key and called that idempotency. It is
-- half of it. The other half is knowing WHY an insert lost the race, and the
-- code could not tell the difference between:
--
--   (a) an event that was fully processed — acknowledge, do nothing;
--   (b) an event another handler is working on RIGHT NOW — do nothing, and do
--       NOT acknowledge, because the other handler may still fail;
--   (c) an event whose handler died — take it over and process it.
--
-- The five-minute reclaim window addressed (c) and got (b) wrong in the way
-- that loses money: inside the window, a losing insert returned `false`, the
-- route answered 200 `{duplicate: true}`, and Stripe marked the event
-- delivered. If the first handler then crashed, timed out, or was killed
-- mid-write, the event was gone. Stripe had been told everything was fine.
-- The payment is never applied and nothing anywhere reports a problem.
--
-- Acknowledging work that is not finished is the bug. The rule now:
--
--     Only a COMPLETED event is acknowledged as a duplicate. An event still
--     being processed gets a retry-me response, so the delivery stays alive
--     until someone actually finishes it.
--
-- And a lease has an OWNER. Every finish and release is scoped to the handler
-- that holds the lease, so a slow handler waking up after its lease expired
-- cannot mark an event done that a second handler is midway through, nor
-- release a claim it no longer holds.
-- ============================================================================

create type stripe_event_state as enum ('processing', 'done', 'failed');

alter table stripe_events
  add column state stripe_event_state not null default 'processing',
  -- Who holds the claim. A fresh uuid per handler invocation, not per process:
  -- two overlapping invocations in one process are still two handlers.
  add column lease_owner uuid,
  add column lease_expires_at timestamptz,
  -- How many times this event has been claimed. A climbing count on an event
  -- that never finishes is the signal that something is wrong with the
  -- handler rather than with Stripe.
  add column attempts integer not null default 0;

-- Rows that predate this migration were only ever written by the old code
-- path, where a processed_at meant done.
update stripe_events set state = 'done' where processed_at is not null;

alter table stripe_events
  add constraint stripe_events_done_is_processed
    check (state <> 'done' or processed_at is not null),
  add constraint stripe_events_lease_has_owner
    check ((lease_owner is null) = (lease_expires_at is null));

-- Finding events that need attention: still processing, lease long gone.
create index stripe_events_stuck on stripe_events (lease_expires_at)
  where state = 'processing';

/**
 * How long a handler gets before its claim may be taken over.
 *
 * The webhook route declares maxDuration = 60s, so a handler that is merely
 * slow is well inside this. Anything past it is not slow, it is gone.
 */
create or replace function stripe_event_lease_seconds() returns integer
language sql immutable set search_path = public as $$ select 300 $$;

/**
 * Claim an event for processing.
 *
 * Returns one of:
 *
 *   'claimed'    — this handler owns it; process it, then finish it.
 *   'completed'  — already processed. Acknowledge; do nothing.
 *   'processing' — someone else holds a live lease. Do NOT acknowledge:
 *                  ask Stripe to redeliver, so the event survives if that
 *                  handler dies.
 *
 * The insert is still the lock for the first delivery. What is new is that
 * losing it is a question rather than an answer.
 */
create or replace function claim_stripe_event(
  p_id      text,
  p_type    text,
  p_payload jsonb,
  p_owner   uuid,
  p_lease_seconds integer default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_row     stripe_events%rowtype;
  v_seconds integer := coalesce(p_lease_seconds, stripe_event_lease_seconds());
begin
  insert into stripe_events (id, type, payload, state, lease_owner,
                             lease_expires_at, attempts)
  values (p_id, p_type, p_payload, 'processing', p_owner,
          clock_timestamp() + make_interval(secs => v_seconds), 1)
  on conflict (id) do nothing;

  if found then return 'claimed'; end if;

  -- Somebody got there first. Under a row lock, work out which case this is.
  select * into v_row from stripe_events where id = p_id for update;

  -- Vanished between the insert and the select: another handler released it.
  -- Treat as an ordinary retry rather than inventing an outcome.
  if v_row.id is null then return 'processing'; end if;

  if v_row.state = 'done' then return 'completed'; end if;

  -- A live lease. NOT a duplicate: the holder may still fail, and telling
  -- Stripe "received" now is what threw the event away.
  -- clock_timestamp(), not now(): now() is the TRANSACTION's start time and
  -- never advances within it, so a lease compared against it can never be
  -- seen to expire from inside a long-running statement. A lease is wall
  -- clock by definition.
  if v_row.state = 'processing'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > clock_timestamp() then
    return 'processing';
  end if;

  -- Either the handler failed and released it, or its lease expired with the
  -- work unfinished. Take it over. Writing a NEW owner is what invalidates
  -- the previous holder: finish_stripe_event and release_stripe_event both
  -- check ownership, so a handler that wakes up late can no longer touch it.
  update stripe_events set
    state            = 'processing',
    type             = p_type,
    payload          = coalesce(p_payload, payload),
    lease_owner      = p_owner,
    lease_expires_at = clock_timestamp() + make_interval(secs => v_seconds),
    attempts         = attempts + 1,
    processed_at     = null,
    outcome          = null,
    error            = null
  where id = p_id;

  return 'claimed';
end $$;

/**
 * Mark an event finished. Only the lease holder may.
 *
 * Returns false when the caller does not hold the lease — which means its
 * lease expired and another handler took over. The right response to that is
 * to leave the event alone and let the new owner finish it; recording an
 * outcome would overwrite work in progress.
 */
create or replace function finish_stripe_event(
  p_id      text,
  p_owner   uuid,
  p_outcome text,
  p_error   text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  update stripe_events set
    state            = 'done',
    processed_at     = clock_timestamp(),
    outcome          = p_outcome,
    error            = p_error,
    lease_owner      = null,
    lease_expires_at = null
  where id = p_id and lease_owner = p_owner;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

/**
 * Give a claim back after the handler failed. Only the lease holder may.
 *
 * The row is KEPT, unlike the delete this replaces. Deleting it threw away
 * the attempt count and the audit trail, and — worse — opened a window in
 * which a concurrent delivery saw no row at all and inserted a fresh claim
 * while the failing handler was still unwinding. Marking it failed with the
 * lease surrendered lets the very next retry take it over immediately, which
 * is the behaviour the delete was reaching for.
 */
create or replace function release_stripe_event(
  p_id    text,
  p_owner uuid,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  update stripe_events set
    state            = 'failed',
    error            = p_error,
    outcome          = null,
    processed_at     = null,
    lease_owner      = null,
    lease_expires_at = null
  where id = p_id and lease_owner = p_owner;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

revoke all on function claim_stripe_event(text, text, jsonb, uuid, integer)
  from public, anon, authenticated;
revoke all on function finish_stripe_event(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function release_stripe_event(text, uuid, text)
  from public, anon, authenticated;
revoke all on function stripe_event_lease_seconds() from public, anon, authenticated;
grant execute on function claim_stripe_event(text, text, jsonb, uuid, integer) to service_role;
grant execute on function finish_stripe_event(text, uuid, text, text) to service_role;
grant execute on function release_stripe_event(text, uuid, text) to service_role;
grant execute on function stripe_event_lease_seconds() to service_role;
