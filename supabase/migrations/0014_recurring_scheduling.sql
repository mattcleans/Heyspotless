-- ============================================================================
-- 0014 — recurring plans that actually recur
--
-- 0001 created `recurring_plans` and `jobs.recurring_plan_id`, and nothing
-- ever wrote to them. Choosing "weekly" on the booking form priced one clean
-- at the weekly rate and put one job on the board; next week's visit was
-- somebody's memory. This is the migration that turns a plan into visits.
--
-- WHAT A DOUBLE-GENERATION COSTS. A recurring customer is the relationship
-- the business is built on. Generating a visit twice is a double booking, a
-- double charge, and a phone call you cannot win; generating none is a
-- customer in a dirty house. Both repeat, every cycle, which is what makes
-- them worse than any one-off going wrong. So idempotency is not a nicety
-- here — it is a unique index:
--
--     jobs (recurring_plan_id, occurrence_date)
--
-- `occurrence_date` is the date the PLAN says a visit belongs to, and it does
-- not move when somebody reschedules the visit itself. That is what makes a
-- reschedule a reschedule rather than an invitation to generate the original
-- slot again next time the sweep runs.
--
-- The decision of WHEN lives in lib/recurring/schedule.ts, pure and tested
-- without a database, in the same shape as dispatch and auto-charge. This
-- executes it.
-- ============================================================================

-- ------------------------------------------------------------- plans ------
alter table recurring_plans
  -- The first visit. The whole cadence is derived from it: its weekday for
  -- weekly and fortnightly, its nth-weekday-of-month for monthly.
  add column anchor_date date,
  -- Local wall clock, business time. Not a timestamp: "9:30" must stay 9:30
  -- for the customer across a daylight-saving change, and a stored instant
  -- would drift an hour twice a year.
  add column start_time time not null default '09:00',
  add column ends_on date,
  -- Visits on or before this are suppressed. A holiday, a long trip.
  add column paused_until date,
  add column paused_reason text,
  /**
   * The cleaner this customer expects to see.
   *
   * The single strongest trust signal in housekeeping is that the same person
   * comes back — it is most of what a recurring relationship IS. Dispatch may
   * not always be able to honour it, so it is a preference rather than an
   * assignment, but it is recorded on the plan so the choice is deliberate
   * rather than whoever the ladder happened to reach.
   */
  add column preferred_cleaner_id uuid references cleaners(id) on delete set null,
  add column notes text,
  -- How far ahead this plan materialises visits. Per-plan so a fussy customer
  -- can see further without filling the board for everyone.
  add column horizon_days integer not null default 42,
  add column last_generated_at timestamptz;

alter table recurring_plans
  add constraint recurring_plans_horizon_sane
    check (horizon_days between 7 and 180),
  add constraint recurring_plans_ends_after_anchor
    check (ends_on is null or anchor_date is null or ends_on >= anchor_date),
  -- A plan with no anchor cannot say when anything happens. Enforced for new
  -- rows; 0001 shipped the table with no anchor column at all.
  add constraint recurring_plans_active_needs_anchor
    check (not active or anchor_date is not null);

-- Existing rows: the plan's own next_job_date is the best anchor available.
update recurring_plans set anchor_date = coalesce(next_job_date, current_date)
where anchor_date is null;

create index recurring_plans_due_for_generation on recurring_plans (last_generated_at)
  where active;

-- ------------------------------------------------------------- skips ------
-- A called-off visit is a ROW, not a deletion. The build plan says skips and
-- reschedules are first-class, and it is right: "why was there no clean on
-- the 29th" is a question somebody will ask months later, and "there is no
-- job row" is not an answer.
create table recurring_plan_skips (
  id              uuid primary key default uuid_generate_v4(),
  plan_id         uuid not null references recurring_plans(id) on delete cascade,
  occurrence_date date not null,
  reason          text,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (plan_id, occurrence_date)
);
create index on recurring_plan_skips (plan_id, occurrence_date);

-- -------------------------------------------------------------- jobs ------
alter table jobs
  -- The slot the plan says this job fills. Stable across a reschedule, which
  -- is exactly why it and not scheduled_start is the idempotency key.
  add column occurrence_date date;

-- THE GUARANTEE. One job per plan per occurrence, for ever, however many
-- times the sweep runs and however many run at once.
create unique index jobs_one_per_occurrence
  on jobs (recurring_plan_id, occurrence_date)
  where recurring_plan_id is not null and occurrence_date is not null;

alter table recurring_plan_skips enable row level security;
create policy recurring_plan_skips_admin_all on recurring_plan_skips for all
  using (is_admin()) with check (is_admin());
-- A customer can see that their own visit was called off, and why.
create policy recurring_plan_skips_own on recurring_plan_skips for select using (
  exists (select 1 from recurring_plans p
          where p.id = recurring_plan_skips.plan_id
            and p.customer_id = current_customer_id())
);

/**
 * Materialise one occurrence of a plan as a job.
 *
 * Returns the job id — the existing one if this occurrence has already been
 * generated, which is the ordinary case every time the sweep runs.
 *
 * The price comes from the PLAN, never from the current price book. That is
 * the fix for the live overbilling bug in build-plan section 09: a recurring
 * customer's agreed rate must not be silently re-derived when the pricelist
 * moves. `agreed_price_cents` is the rate they said yes to.
 */
create or replace function materialise_recurring_job(
  p_plan_id         uuid,
  p_occurrence_date date,
  p_scheduled_start timestamptz
) returns uuid
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

  -- Never re-create a visit somebody called off. Checked BEFORE the existing
  -- job, because a skip leaves the cancelled row behind on purpose — the
  -- audit trail — and returning that row would tell the caller a visit is
  -- scheduled when the customer has been told it is not. Null means "no
  -- visit here", which is the truth.
  if exists (select 1 from recurring_plan_skips
             where plan_id = p_plan_id and occurrence_date = p_occurrence_date) then
    return null;
  end if;

  -- Already there. The sweep runs daily over a six-week horizon, so almost
  -- every occurrence is seen dozens of times before it happens.
  select id into v_job_id from jobs
  where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;
  if v_job_id is not null then return v_job_id; end if;

  insert into jobs (
    customer_id, property_id, recurring_plan_id, occurrence_date, status,
    service, freq, scheduled_start, price_cents, estimated_clean_minutes, notes
  ) values (
    v_plan.customer_id, v_plan.property_id, p_plan_id, p_occurrence_date, 'scheduled',
    v_plan.service, v_plan.freq, p_scheduled_start,
    v_plan.agreed_price_cents, v_plan.estimated_minutes, v_plan.notes
  )
  -- The index is the real guarantee: two sweeps racing on the same occurrence
  -- both reach here, and exactly one row survives.
  on conflict (recurring_plan_id, occurrence_date)
    where recurring_plan_id is not null and occurrence_date is not null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id into v_job_id from jobs
    where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;
  end if;

  update recurring_plans set
    last_generated_at = now(),
    next_job_date = least(coalesce(next_job_date, p_occurrence_date), p_occurrence_date)
  where id = p_plan_id;

  return v_job_id;
end $$;

/**
 * Call off one occurrence. Idempotent, and never touches a job that has
 * already happened — cancelling a completed clean is a different act with
 * different money attached, and it is not this one.
 */
create or replace function skip_recurring_occurrence(
  p_plan_id         uuid,
  p_occurrence_date date,
  p_reason          text default null,
  p_created_by      uuid default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_status job_status;
begin
  insert into recurring_plan_skips (plan_id, occurrence_date, reason, created_by)
  values (p_plan_id, p_occurrence_date, p_reason, p_created_by)
  on conflict (plan_id, occurrence_date) do nothing;

  select status into v_status from jobs
  where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;

  if v_status is null then return true; end if;
  if v_status in ('complete', 'in_progress') then
    raise exception 'cannot skip the % visit on %: it is already %',
      p_plan_id, p_occurrence_date, v_status;
  end if;

  update jobs set status = 'canceled'
  where recurring_plan_id = p_plan_id and occurrence_date = p_occurrence_date;

  return true;
end $$;

/** Undo a skip. The job is not resurrected; the next sweep re-creates it. */
create or replace function unskip_recurring_occurrence(
  p_plan_id         uuid,
  p_occurrence_date date
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from recurring_plan_skips
  where plan_id = p_plan_id and occurrence_date = p_occurrence_date;
  get diagnostics v_deleted = row_count;

  -- A cancelled job for that slot would block regeneration through the
  -- unique index, so it is cleared out of the way.
  delete from jobs
  where recurring_plan_id = p_plan_id
    and occurrence_date = p_occurrence_date
    and status = 'canceled';

  return v_deleted > 0;
end $$;

revoke all on function materialise_recurring_job(uuid, date, timestamptz)
  from public, anon, authenticated;
revoke all on function skip_recurring_occurrence(uuid, date, text, uuid)
  from public, anon, authenticated;
revoke all on function unskip_recurring_occurrence(uuid, date)
  from public, anon, authenticated;
grant execute on function materialise_recurring_job(uuid, date, timestamptz) to service_role;
grant execute on function skip_recurring_occurrence(uuid, date, text, uuid) to service_role;
grant execute on function unskip_recurring_occurrence(uuid, date) to service_role;
