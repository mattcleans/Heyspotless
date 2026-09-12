-- ============================================================================
-- 0017 — a relationship ends for a reason, not for a price
--
-- POLICY, from Matt, 12 September 2026.
--
-- 0015 made continuity the default and then priced it: a REVEALED incumbency
-- (she has simply always been the one who comes) was given up whenever keeping
-- her cost more than 15% of the ticket above the cheapest alternative. In
-- practice that fired constantly, because an idle W-2 inside guaranteed hours
-- costs nothing and a contractor costs her whole payout — about 33-36% of the
-- ticket at every job size on the current pricelist. So the effective rule was
-- "a customer loses their cleaner whenever Shonda has a spare hour".
--
-- That is backwards. The relationship IS the product. A cleaner who has been
-- to a house before keeps going to that house unless something real ends it:
-- the customer asks for somebody else, the customer complains, the cleaner
-- cannot take it, or she turns it down. Not because payroll had a gap that
-- week.
--
-- Two things follow, and this migration is both of them.
--
-- 1. THE REASONS NEED SOMEWHERE TO LIVE. "The customer complained" was not
--    recordable anywhere, so it could not end a relationship even though it is
--    the main thing that should. `property_cleaner_blocks` is that record.
--
-- 2. THE SPREAD HAS TO BE LOCKED ON BOTH SIDES. If a pairing lasts years then
--    the margin agreed when it formed is the margin for years, so both halves
--    of it must be fixed at formation. 0014 locked what the CUSTOMER pays on
--    `recurring_plans.agreed_price_cents` — and nothing locked what the
--    CLEANER is paid. Every incumbent offer was priced from the global opening
--    rate at dispatch time, so raising that rate to attract supply would have
--    quietly cut the margin on every existing recurring relationship, with no
--    record of what was ever agreed. That is the same bug 0014 fixed for the
--    customer, pointing the other way.
-- ============================================================================

-- --------------------------------------------------- 1. ending it ----------
/**
 * This cleaner does not go back to this property.
 *
 * Per PROPERTY, matching how incumbency is measured in 0016: a cleaner who was
 * wrong for the rental is not necessarily wrong for the house, and a blanket
 * block would throw away a working relationship to settle a different one.
 *
 * A ROW, not a deletion or a flag, for the same reason a skip is a row: "why
 * did Marisol stop coming to the Lutich house in March" is a question somebody
 * asks a year later, and "the incumbency simply is not there any more" is not
 * an answer.
 */
create type relationship_end_reason as enum (
  'customer_requested_change',  -- they asked for somebody else, no fault stated
  'customer_complaint',         -- the work or the conduct was the problem
  'cleaner_declined_ongoing',   -- she does not want this customer any more
  'operational'                 -- route, schedule, capacity. Nobody's fault
);

create table property_cleaner_blocks (
  id          uuid primary key default uuid_generate_v4(),
  property_id uuid not null references properties(id) on delete cascade,
  cleaner_id  uuid not null references cleaners(id) on delete cascade,
  reason      relationship_end_reason not null,
  note        text,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- Lifted when it was a misunderstanding, or when the customer asks for her
  -- back. Kept as a row either way.
  lifted_at   timestamptz,
  lifted_by   uuid references profiles(id) on delete set null
);

-- One live block per pairing. Blocking twice is not twice as blocked, and a
-- second row would make "is she blocked" a question with two answers.
create unique index property_cleaner_blocks_one_live
  on property_cleaner_blocks (property_id, cleaner_id) where lifted_at is null;
create index on property_cleaner_blocks (cleaner_id) where lifted_at is null;

comment on table property_cleaner_blocks is
  'A cleaner who does not go back to a property, and why. Substitution is '
  'driven by these rows and by eligibility -- never by cost. See 0017.';

alter table property_cleaner_blocks enable row level security;
create policy property_cleaner_blocks_admin_all on property_cleaner_blocks for all
  using (is_admin()) with check (is_admin());

-- Deliberately no cleaner-facing policy. A cleaner does not need to read that
-- a customer asked for her not to come back, and a list of the houses that
-- have blocked her is not something the platform should hand anybody.

-- --------------------------------------------------- 2. the spread ---------
/**
 * What the CLEANER was agreed for this relationship, per hour.
 *
 * Stored as a rate rather than a total because the total follows from the
 * estimate, and an estimate that is revised (a customer finishes the attic)
 * should move the payout with it rather than silently changing her hourly.
 *
 * Null means no rate was ever agreed and the current opening rate applies,
 * which is the honest reading for every relationship that predates this
 * column. It is not a free discount: it means unlocked, not zero.
 */
alter table recurring_plans
  add column agreed_payout_rate_cents integer
    check (agreed_payout_rate_cents is null or agreed_payout_rate_cents > 0);

comment on column recurring_plans.agreed_payout_rate_cents is
  'The cleaner hourly rate agreed when this relationship formed, in cents. '
  'The mirror of agreed_price_cents: together they fix the spread for the '
  'life of the plan. Null means unlocked, not free.';

alter table jobs
  add column agreed_payout_rate_cents integer
    check (agreed_payout_rate_cents is null or agreed_payout_rate_cents > 0);

comment on column jobs.agreed_payout_rate_cents is
  'Snapshotted from the plan at materialisation, like preferred_cleaner_id -- '
  'so a rate renegotiated in March does not rewrite what February was '
  'dispatched at.';

-- Carry both snapshots onto every generated visit.
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
    preferred_cleaner_id, agreed_payout_rate_cents
  ) values (
    v_plan.customer_id, v_plan.property_id, p_plan_id, p_occurrence_date, 'scheduled',
    v_plan.service, v_plan.freq, p_scheduled_start,
    v_plan.agreed_price_cents, v_plan.estimated_minutes, v_plan.notes,
    v_plan.preferred_cleaner_id, v_plan.agreed_payout_rate_cents
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

-- ------------------------------------------------- 3. the view -------------
-- Incumbency now respects a block, and carries the agreed rate so dispatch
-- never has to reach for the global one on a relationship that has its own.
--
-- Dropped rather than replaced: `create or replace view` cannot add a column
-- in the middle of the list, and keeping the two snapshot columns together is
-- worth more than avoiding a drop on a view that holds no data.
drop view if exists job_continuity;

create view job_continuity
with (security_invoker = true) as
select
  j.id                          as job_id,
  j.property_id,
  j.preferred_cleaner_id,
  j.agreed_payout_rate_cents,
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
    -- A blocked cleaner is not an incumbent, however many times she has been.
    -- Filtered HERE rather than at the engine so a block cannot be missed by a
    -- caller that forgot to ask: there is one definition of who cleans this
    -- house and it is this view.
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
  'Per-job continuity inputs: the stated preference and agreed cleaner rate '
  'carried onto the visit, and the cleaner who most recently completed a visit '
  'at that property and is not blocked from it. Feeds resolveContinuity().';

/**
 * End a relationship, and say why.
 *
 * The stated preference is cleared at the same time when it names the blocked
 * cleaner: leaving it pointing at somebody who may not come back would make
 * every future visit report "the customer's requested cleaner is unavailable"
 * for ever, which is true and useless.
 */
create or replace function block_cleaner_from_property(
  p_property_id uuid,
  p_cleaner_id  uuid,
  p_reason      relationship_end_reason,
  p_note        text default null,
  p_created_by  uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into property_cleaner_blocks (property_id, cleaner_id, reason, note, created_by)
  values (p_property_id, p_cleaner_id, p_reason, p_note, p_created_by)
  on conflict (property_id, cleaner_id) where lifted_at is null
  do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from property_cleaner_blocks
    where property_id = p_property_id and cleaner_id = p_cleaner_id and lifted_at is null;
  end if;

  update recurring_plans set preferred_cleaner_id = null
  where property_id = p_property_id and preferred_cleaner_id = p_cleaner_id;

  -- Visits already on the board that have not happened yet. A block is about
  -- the future; a clean she has already done is history and stays.
  update jobs set preferred_cleaner_id = null
  where property_id = p_property_id
    and preferred_cleaner_id = p_cleaner_id
    and status in ('unscheduled', 'scheduled', 'dispatching');

  return v_id;
end $$;

/** She comes back. The block stays as a row; it is simply no longer in force. */
create or replace function lift_cleaner_block(
  p_property_id uuid,
  p_cleaner_id  uuid,
  p_lifted_by   uuid default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update property_cleaner_blocks
  set lifted_at = now(), lifted_by = p_lifted_by
  where property_id = p_property_id and cleaner_id = p_cleaner_id and lifted_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function block_cleaner_from_property(uuid, uuid, relationship_end_reason, text, uuid)
  from public, anon, authenticated;
revoke all on function lift_cleaner_block(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function block_cleaner_from_property(uuid, uuid, relationship_end_reason, text, uuid)
  to service_role;
grant execute on function lift_cleaner_block(uuid, uuid, uuid) to service_role;
