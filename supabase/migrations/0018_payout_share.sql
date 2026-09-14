-- ============================================================================
-- 0018 — the payout is a share of the ticket
--
-- POLICY (Matt, 14 September 2026). A clean pays the cleaner 40% of whatever
-- the customer pays. A discount to the customer reduces her fee in proportion,
-- because the two are the same number scaled.
--
-- This reverses the per-hour ladder, and 0017 is two days old, so the record
-- of why is worth keeping rather than tidying away.
--
-- WHAT WAS WRONG WITH PER-HOUR. The payout was a rate multiplied by OUR
-- estimate of the job's length, which makes the cleaner's fee a function of our
-- guess: estimate a 3bd/3ba at 173 minutes, and if it really takes 240 we have
-- underpaid her by the size of our own error. Paying by the hour is also an
-- employment marker, and worker classification is the largest legal exposure in
-- the plan. A published price per clean is how you buy a service from a
-- business.
--
-- WHAT 0017 GOT WRONG AS A RESULT. It added `agreed_payout_rate_cents` to lock
-- the cleaner's half of the spread, because a global hourly rate meant raising
-- that rate to attract new supply would silently re-cut the margin on every
-- existing relationship. Pricing off the ticket removes the problem rather than
-- guarding against it: `agreed_price_cents` already locks what the customer
-- pays for the life of the plan, and a constant share of a locked price is a
-- locked payout. The spread is fixed by construction.
--
-- So the column becomes a SHARE, and its job changes from protecting the
-- spread to recording a negotiated exception — a cleaner worth more than
-- standard, or a customer nobody else will take. Almost always null.
--
-- WHAT THIS COSTS, ON THE RECORD. A flat share pays the worst effective hourly
-- rate on the discounted jobs, which are the recurring ones. Same house, same
-- work: a weekly 3bd/3ba pays $77.60 where the one-time pays $96.40. On an open
-- board a rational cleaner takes the one-time. That is survivable now only
-- because dispatch is no longer an open board for established customers —
-- 0015 gives a recurring visit to its incumbent exclusively first. The exposure
-- that remains is ACQUISITION: a new recurring customer has no incumbent and is
-- the worst-paying job on the board. See MINIMUM_PAYOUT_CENTS in
-- lib/pricing/payout.ts, which exists for that and is off.
-- ============================================================================

-- ------------------------------------------------ the negotiated share -----
-- The view reads the column being replaced, so it goes first and is rebuilt at
-- the bottom once the new shape exists.
drop view if exists job_continuity;

alter table recurring_plans drop column if exists agreed_payout_rate_cents;
alter table jobs            drop column if exists agreed_payout_rate_cents;

alter table recurring_plans
  add column agreed_payout_share numeric(4,3)
    check (agreed_payout_share is null
           or (agreed_payout_share > 0 and agreed_payout_share <= 1));

comment on column recurring_plans.agreed_payout_share is
  'A negotiated share of the ticket for this relationship. Null means the '
  'standard share applies, which is the ordinary case. Not a spread guard -- '
  'agreed_price_cents times a constant share already fixes the spread.';

alter table jobs
  add column agreed_payout_share numeric(4,3)
    check (agreed_payout_share is null
           or (agreed_payout_share > 0 and agreed_payout_share <= 1));

comment on column jobs.agreed_payout_share is
  'Snapshotted from the plan at materialisation, so a share renegotiated in '
  'March does not rewrite what February was dispatched at.';

-- ------------------------------------------------------ the offer ----------
-- The two columns already existed; what they MEAN is now the other way round.
-- `payout_pct` was a derived read-out of a per-hour offer. It is now the
-- input: the share the offer was made at, and the dimension the ladder
-- escalates in. `hourly_rate_cents` was the input and is now a reading --
-- still worth keeping, because cleaner earnings per hour is a metric the
-- business steers by and a share model makes it vary per job in a way the
-- per-hour model hid. It needs to stay visible precisely because it is no
-- longer controlled.
comment on column offers.payout_pct is
  'The share of the ticket this offer was made at. THE INPUT: the ladder '
  'escalates in share, and this is what an offer is compared against when '
  'deciding whether a cleaner has already been asked. See 0018.';

comment on column offers.hourly_rate_cents is
  'What this offer works out at per hour against the estimate. A READING, not '
  'a price -- nothing is priced per hour. Kept because cleaner earnings/hour '
  'is a metric the business steers by. See 0018.';

-- payout_pct carried four decimal places as a derived percentage. As the input
-- it is compared for equality across sweeps, so it needs to hold exactly what
-- the ladder produced -- which steps in hundredths of a percentage point.
alter table offers alter column payout_pct type numeric(6,5);

create or replace function record_offer(
  p_job_id        uuid,
  p_cleaner_id    uuid,
  p_decision_id   uuid,
  p_channel       dispatch_channel,
  p_tier          integer,
  p_share         numeric,
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
    p_job_id, p_cleaner_id, p_decision_id, p_channel, p_tier,
    -- The reading, derived here so every offer carries it without the caller
    -- having to remember. Zero-length estimates read as zero rather than
    -- dividing by nothing.
    case when p_estimated_minutes > 0
         then round((p_payout_cents::numeric * 60) / p_estimated_minutes)::integer
         else 0 end,
    p_payout_cents, p_share, p_estimated_minutes, p_expires_at, p_is_exclusive
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

drop function if exists record_offer(uuid, uuid, uuid, dispatch_channel, integer, integer,
                                     integer, integer, timestamptz, boolean);

revoke all on function record_offer(uuid, uuid, uuid, dispatch_channel, integer, numeric,
                                    integer, integer, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function record_offer(uuid, uuid, uuid, dispatch_channel, integer, numeric,
                                       integer, integer, timestamptz, boolean) to service_role;

-- ------------------------------------------------ materialisation ----------
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
    preferred_cleaner_id, agreed_payout_share
  ) values (
    v_plan.customer_id, v_plan.property_id, p_plan_id, p_occurrence_date, 'scheduled',
    v_plan.service, v_plan.freq, p_scheduled_start,
    v_plan.agreed_price_cents, v_plan.estimated_minutes, v_plan.notes,
    v_plan.preferred_cleaner_id, v_plan.agreed_payout_share
  )
  on conflict (recurring_plan_id, occurrence_date)
    where recurring_plan_id is not null and occurrence_date is not null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
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

-- ------------------------------------------------------- the view ----------
create view job_continuity
with (security_invoker = true) as
select
  j.id                          as job_id,
  j.property_id,
  j.preferred_cleaner_id,
  j.agreed_payout_share,
  inc.cleaner_id                as incumbent_cleaner_id,
  coalesce(inc.visits, 0)       as prior_visits
from jobs j
left join lateral (
  select ja.cleaner_id,
         count(*)                        as visits,
         max(prior.scheduled_start)      as last_visit_at
  from jobs prior
  join job_assignments ja on ja.job_id = prior.id
  where prior.property_id = j.property_id
    and prior.id <> j.id
    and prior.status = 'complete'
    and not exists (
      select 1 from property_cleaner_blocks b
      where b.property_id = j.property_id
        and b.cleaner_id = ja.cleaner_id
        and b.lifted_at is null
    )
  group by ja.cleaner_id
  order by max(prior.scheduled_start) desc nulls last
  limit 1
) inc on true;

comment on view job_continuity is
  'Per-job continuity inputs: the stated preference and any negotiated payout '
  'share carried onto the visit, and the cleaner who most recently completed a '
  'visit at that property and is not blocked from it.';
