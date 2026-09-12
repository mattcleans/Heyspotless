-- ============================================================================
-- 0015 — the offer lifecycle, and continuity that survives a page render
--
-- WHAT WAS BROKEN. The dispatch engine was a pure function called while
-- drawing the admin board. It decided who should get every job, built the
-- ladder, priced each rung against that cleaner's true marginal cost — and
-- then the request ended and all of it was discarded. `offers` has existed
-- since 0001 and nothing has ever written a row to it. So:
--
--   * no cleaner could accept anything, because nothing was ever offered;
--   * the service loop stopped dead at "cleaner matching", and every step
--     after it — acceptance, confirmation, payout — was unreachable;
--   * acceptance rate, escalation rate, time-to-fill and % auto-assigned were
--     not merely unreported but unrecoverable, because the decision that
--     would have produced them was never written down.
--
-- This migration persists the decision, persists the offers that follow from
-- it, and makes responding to one an atomic operation the database arbitrates
-- rather than something the application hopes about.
--
-- WHY THE RESPONSE IS A FUNCTION AND NOT AN UPDATE. 0007 dropped the
-- `offers_respond` policy that let a cleaner update her own offer row, and was
-- right to: that permission also let her change `payout_cents`. Accepting is
-- not one write. It is: check the offer is still live, check the JOB is still
-- unclaimed, mark the offer accepted, create the assignment at the payout THE
-- OFFER states, move the job to assigned, and withdraw every other offer out
-- on that job — all of it, or none of it. Two cleaners tapping Accept in the
-- same second must produce one assignment and one loser who is told plainly
-- that the job is gone.
-- ============================================================================

-- ------------------------------------------------- continuity on the job ---
/**
 * The cleaner this customer expects, carried down from the plan onto the visit.
 *
 * 0014 put `preferred_cleaner_id` on the plan and nothing ever read it. It has
 * to live on the JOB as well, not only the plan, because the preference at the
 * moment a visit was dispatched is not the preference today — a customer who
 * switches cleaners in March must not rewrite what February's visits were
 * dispatched against, or every continuity number becomes a measure of the
 * current roster instead of what actually happened.
 */
alter table jobs
  add column preferred_cleaner_id uuid references cleaners(id) on delete set null;

comment on column jobs.preferred_cleaner_id is
  'The incumbent at the time this visit was created, copied from the recurring '
  'plan. Deliberately a snapshot, not a join — see 0015.';

-- --------------------------------------------------- dispatch decisions ----
/**
 * What the engine decided, when, and why.
 *
 * One row per decision, not one per job: a job that is held for its incumbent,
 * declined, posted to the board and then escalated has four decisions, and the
 * sequence is the interesting part. The job row only ever shows the last one.
 */
create table dispatch_decisions (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs(id) on delete cascade,
  -- Matches DispatchDecision["kind"] in lib/dispatch/engine.ts.
  kind        text not null check (kind in (
                'assign_guaranteed', 'assign_w2', 'hold_for_incumbent',
                'open_board', 'waterfall', 'no_eligible_cleaner')),
  -- Who it resolved to, where it resolved to anyone.
  cleaner_id  uuid references cleaners(id) on delete set null,

  -- Continuity, as lib/dispatch/continuity.ts reports it.
  continuity_status text not null default 'none' check (continuity_status in (
                'held', 'assigned', 'waived_too_costly', 'none')),
  continuity_basis  text check (continuity_basis in ('preferred', 'incumbent')),
  continuity_reason text,
  /**
   * What continuity cost against the cheapest alternative, in cents. Negative
   * means the incumbent WAS the cheapest — the ordinary case for a W-2 on a
   * settled route, and worth being able to prove.
   */
  continuity_premium_cents integer,

  marginal_cents    integer,
  w2_ceiling_cents  integer,
  rationale         text not null,

  /**
   * THE INTERVENTION MARKER.
   *
   * Null means the engine decided this by itself. Not null means a person
   * did — an override, a manual assignment, a reassignment after a complaint.
   * The north-star metric is manager interventions per 100 completed cleans,
   * and this single nullable column is the whole numerator. It is here from
   * the first decision ever recorded because it cannot be backfilled: nothing
   * else in the schema distinguishes a job the engine filled from one a human
   * filled on the phone.
   */
  decided_by  uuid references profiles(id) on delete set null,
  decided_at  timestamptz not null default now()
);
create index on dispatch_decisions (job_id, decided_at desc);
create index on dispatch_decisions (decided_at) where decided_by is not null;
create index on dispatch_decisions (continuity_status, decided_at);

-- ------------------------------------------------------------- offers ------
-- 0001 shipped the table. These are what the lifecycle needs on top of it.
alter table offers
  -- Which decision produced this offer, so an acceptance can be traced back to
  -- the reasoning that caused it.
  add column decision_id uuid references dispatch_decisions(id) on delete set null,
  -- True while the incumbent has the job to herself. An exclusive offer that
  -- expires is what promotes the job to the open board.
  add column is_exclusive boolean not null default false,
  add column decline_reason text;

/**
 * At most one LIVE offer per cleaner per job.
 *
 * Not one offer per cleaner per job: a cleaner who declines the opening rung
 * may legitimately be offered a later one — and must be, or the incumbent who
 * says no at $25/h watches a stranger take her customer at $30/h and learns
 * never to answer the first offer honestly again. What must not exist is two
 * offers she could both accept.
 */
create unique index offers_one_live_per_cleaner_job
  on offers (job_id, cleaner_id) where status = 'sent';

create index on offers (status, expires_at) where status = 'sent';

-- ============================================================================
-- RESPONDING
-- ============================================================================

/**
 * Accept or decline one offer, atomically.
 *
 * Outcomes, in the shape `begin_payment_operation` established in 0012 —
 * every one of these is an ordinary thing that happens, not an error:
 *
 *   'accepted'    — hers. The assignment exists.
 *   'declined'    — recorded; the job carries on without her.
 *   'taken'       — somebody else got there first. The commonest race, and
 *                   the one the cleaner must be told about honestly.
 *   'expired'     — the countdown ran out before she tapped.
 *   'superseded'  — she already answered this one.
 *   'not_found'   — no such offer for this cleaner.
 *
 * The payout written to the assignment comes from the OFFER ROW, never from a
 * parameter. That is the reason this is a function at all: 0007 removed the
 * cleaner's UPDATE permission on offers precisely because it doubled as
 * permission to rewrite her own payout, and an accept endpoint that took an
 * amount would hand it straight back.
 */
create or replace function respond_to_offer(
  p_offer_id   uuid,
  p_cleaner_id uuid,
  p_accept     boolean,
  p_reason     text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_offer   offers%rowtype;
  v_job     jobs%rowtype;
  v_taken   boolean;
begin
  select * into v_offer from offers
  where id = p_offer_id and cleaner_id = p_cleaner_id;
  if v_offer.id is null then return 'not_found'; end if;

  if v_offer.status <> 'sent' then
    -- Already answered, withdrawn, or expired by the sweep. Re-tapping a
    -- button on a stale screen must not change anything.
    return case when v_offer.status = 'expired' then 'expired' else 'superseded' end;
  end if;

  -- Lock the JOB, not the offer. The race worth arbitrating is two cleaners
  -- accepting two different offers on one job; locking each of their own rows
  -- would let both through.
  select * into v_job from jobs where id = v_offer.job_id for update;
  if v_job.id is null then return 'not_found'; end if;

  if not p_accept then
    update offers set status = 'declined', responded_at = now(), decline_reason = p_reason
    where id = p_offer_id;
    return 'declined';
  end if;

  -- Expiry is checked under the lock and against the database's clock, so a
  -- device with a slow clock cannot accept a countdown that has already run
  -- out somewhere else.
  if v_offer.expires_at <= now() then
    update offers set status = 'expired', responded_at = now() where id = p_offer_id;
    return 'expired';
  end if;

  select exists (select 1 from job_assignments where job_id = v_offer.job_id)
  into v_taken;
  if v_taken then
    -- Not her fault and not an error. Withdraw the offer so it stops counting
    -- against her acceptance rate — declining work that no longer exists is
    -- not declining work, and a ranking that says otherwise punishes the
    -- cleaners who answer fastest.
    update offers set status = 'withdrawn', responded_at = now() where id = p_offer_id;
    return 'taken';
  end if;

  update offers set status = 'accepted', responded_at = now() where id = p_offer_id;

  insert into job_assignments (job_id, cleaner_id, offer_id, is_lead, payout_cents)
  values (v_offer.job_id, p_cleaner_id, p_offer_id, true, v_offer.payout_cents);

  update jobs set status = 'assigned', dispatch_channel = v_offer.channel
  where id = v_offer.job_id;

  -- Everyone else's screen goes quiet. Withdrawn rather than expired: the
  -- offer did not run out of time, it stopped existing.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = v_offer.job_id and id <> p_offer_id and status = 'sent';

  return 'accepted';
end $$;

/**
 * Write an offer.
 *
 * Idempotent on (job, cleaner) while one is live, so a double-submitted
 * dispatch run re-presents the SAME offer rather than a second one the cleaner
 * could accept twice. The eligibility CHECK from 0003 still applies and is the
 * real gate — this cannot write an offer the gate would refuse.
 */
create or replace function record_offer(
  p_job_id        uuid,
  p_cleaner_id    uuid,
  p_decision_id   uuid,
  p_channel       dispatch_channel,
  p_tier          integer,
  p_hourly_rate_cents integer,
  p_payout_cents  integer,
  p_estimated_minutes integer,
  p_expires_at    timestamptz,
  p_is_exclusive  boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from offers
  where job_id = p_job_id and cleaner_id = p_cleaner_id and status = 'sent';
  if v_id is not null then return v_id; end if;

  insert into offers (
    job_id, cleaner_id, decision_id, channel, tier, hourly_rate_cents,
    payout_cents, payout_pct, estimated_minutes, expires_at, is_exclusive
  )
  select
    p_job_id, p_cleaner_id, p_decision_id, p_channel, p_tier, p_hourly_rate_cents,
    p_payout_cents,
    case when j.price_cents > 0
         then round(p_payout_cents::numeric / j.price_cents, 4) else 0 end,
    p_estimated_minutes, p_expires_at, p_is_exclusive
  from jobs j where j.id = p_job_id
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from offers
    where job_id = p_job_id and cleaner_id = p_cleaner_id and status = 'sent';
  end if;

  update jobs set status = 'dispatching', dispatch_channel = p_channel
  where id = p_job_id and status in ('unscheduled', 'scheduled');

  return v_id;
end $$;

/**
 * Time out every offer whose countdown has passed.
 *
 * Run by the dispatch sweep before it decides anything, so a job whose
 * exclusive hold has lapsed is seen as unheld rather than still waiting on
 * somebody who never answered. Returns how many lapsed, which is the raw
 * material for time-to-fill and for the non-response rate that should cost a
 * cleaner her ranking.
 */
create or replace function expire_stale_offers() returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update offers set status = 'expired', responded_at = now()
  where status = 'sent' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ------------------------------------------------------- row level security
alter table dispatch_decisions enable row level security;

create policy dispatch_decisions_admin_all on dispatch_decisions for all
  using (is_admin()) with check (is_admin());

/**
 * A cleaner may see the decisions that named her, and nothing else.
 *
 * Deliberately not "every decision on a job she was offered": the rationale
 * says what the alternative cost and who else was considered, and that is the
 * marketplace's information, not hers. Customers see none of it — a customer
 * reading that keeping their cleaner cost $14 more than the alternative is a
 * conversation nobody benefits from.
 */
create policy dispatch_decisions_own on dispatch_decisions for select
  using (cleaner_id = current_cleaner_id());

revoke all on function respond_to_offer(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function record_offer(uuid, uuid, uuid, dispatch_channel, integer, integer,
                                    integer, integer, timestamptz, boolean)
  from public, anon, authenticated;
revoke all on function expire_stale_offers() from public, anon, authenticated;

grant execute on function respond_to_offer(uuid, uuid, boolean, text) to service_role;
grant execute on function record_offer(uuid, uuid, uuid, dispatch_channel, integer, integer,
                                       integer, integer, timestamptz, boolean) to service_role;
grant execute on function expire_stale_offers() to service_role;

-- ============================================================================
-- Carry the plan's preferred cleaner onto each generated visit, and tell the
-- caller whether it actually created anything.
--
-- The second half fixes a counting bug in /api/recurring/generate: the sweep
-- reported every materialised occurrence as `created`, including the dozens of
-- times it re-saw a visit it had already made, while the `existing` counter it
-- also reported sat at zero for ever. Over a six-week horizon swept nightly
-- that overstates the only autonomous loop in the system by about fortyfold.
-- ============================================================================
drop function if exists materialise_recurring_job(uuid, date, timestamptz);

create or replace function materialise_recurring_job(
  p_plan_id         uuid,
  p_occurrence_date date,
  p_scheduled_start timestamptz
) returns table (job_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_plan recurring_plans%rowtype;
  v_job_id uuid;
begin
  select * into v_plan from recurring_plans where id = p_plan_id for update;
  if v_plan.id is null then
    raise exception 'recurring plan % not found', p_plan_id;
  end if;
  if not v_plan.active then
    raise exception 'recurring plan % is not active', p_plan_id;
  end if;

  if exists (select 1 from recurring_plan_skips
             where plan_id = p_plan_id and occurrence_date = p_occurrence_date) then
    return query select null::uuid, false;
    return;
  end if;

  select id into v_job_id from jobs
  where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;
  if v_job_id is not null then
    return query select v_job_id, false;
    return;
  end if;

  insert into jobs (
    customer_id, property_id, recurring_plan_id, occurrence_date, status,
    service, freq, scheduled_start, price_cents, estimated_clean_minutes, notes,
    preferred_cleaner_id
  ) values (
    v_plan.customer_id, v_plan.property_id, p_plan_id, p_occurrence_date, 'scheduled',
    v_plan.service, v_plan.freq, p_scheduled_start,
    v_plan.agreed_price_cents, v_plan.estimated_minutes, v_plan.notes,
    v_plan.preferred_cleaner_id
  )
  on conflict (recurring_plan_id, occurrence_date)
    where recurring_plan_id is not null and occurrence_date is not null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- Lost the race. The other sweep created it; this one did not.
    select id into v_job_id from jobs
    where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;

    update recurring_plans set last_generated_at = now() where id = p_plan_id;
    return query select v_job_id, false;
    return;
  end if;

  update recurring_plans set
    last_generated_at = now(),
    next_job_date = least(coalesce(next_job_date, p_occurrence_date), p_occurrence_date)
  where id = p_plan_id;

  return query select v_job_id, true;
end $$;

revoke all on function materialise_recurring_job(uuid, date, timestamptz)
  from public, anon, authenticated;
grant execute on function materialise_recurring_job(uuid, date, timestamptz) to service_role;
