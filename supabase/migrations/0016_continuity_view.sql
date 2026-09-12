-- ============================================================================
-- 0016 — who already cleans this house
--
-- The engine's continuity step needs two facts that are not columns and must
-- not be denormalised into one, for the same reason as 0005: they change every
-- time a visit is completed.
--
--   preferred_cleaner_id  — what the customer SAID, snapshotted onto the visit
--                           by 0015 so a change of mind in March does not
--                           rewrite what February was dispatched against.
--   incumbent_cleaner_id  — what actually HAPPENED: whoever cleaned this
--                           property last, whether anyone ever wrote it down.
--
-- Kept apart on purpose. A stated preference outranks a revealed one, because
-- a customer who asked for Sarah has told us something the history cannot —
-- that the last visit being somebody else was a substitution, not a change of
-- heart. lib/dispatch/continuity.ts is where that ordering lives; this only
-- supplies the facts.
--
-- INCUMBENCY IS PER PROPERTY, NOT PER CUSTOMER. A customer with a house and a
-- rental has two relationships, and the cleaner who does the rental every
-- fortnight has no claim on the house. Getting this wrong would hold a job for
-- somebody who has never been to the address.
-- ============================================================================

-- The view's lateral runs once per job on the board, and looks up completed
-- visits at that job's property. Without this it is a sequential scan of every
-- job in the system per row, which is invisible on a demo book and quadratic
-- on a real one.
create index if not exists jobs_property_completed
  on jobs (property_id, scheduled_start desc) where status = 'complete';

create or replace view job_continuity
with (security_invoker = true) as
select
  j.id                          as job_id,
  j.property_id,
  j.preferred_cleaner_id,
  inc.cleaner_id                as incumbent_cleaner_id,
  coalesce(inc.visits, 0)       as prior_visits
from jobs j
left join lateral (
  -- The cleaner who did the most recent COMPLETED visit at this property, and
  -- how many she has done there. Completed, not assigned: a job somebody was
  -- sent to and did not do is not a relationship, and counting it would hold
  -- future visits for a cleaner the customer may have asked never to see
  -- again.
  select ja.cleaner_id,
         count(*)                        as visits,
         max(prior.scheduled_start)      as last_visit_at
  from jobs prior
  join job_assignments ja on ja.job_id = prior.id
  where prior.property_id = j.property_id
    and prior.id <> j.id
    and prior.status = 'complete'
  group by ja.cleaner_id
  order by max(prior.scheduled_start) desc nulls last
  limit 1
) inc on true;

comment on view job_continuity is
  'Per-job continuity inputs: the stated preference carried onto the visit, '
  'and the cleaner who most recently completed a visit at that property with '
  'how many she has done there. Feeds resolveContinuity() in lib/dispatch.';

/**
 * Assign a W-2 cleaner with no offer and no countdown.
 *
 * An employee is scheduled; a contractor is asked. The engine decides which of
 * those a cleaner is, and the split is not cosmetic — routing a contractor
 * through here would be the platform exercising the control that makes her an
 * employee whatever the paperwork says.
 *
 * Returns false when somebody claimed the job between the decision and this
 * write. That is an ordinary race on a board being swept, not an error: the
 * next sweep will see the job as filled and leave it alone.
 */
create or replace function assign_job_directly(
  p_job_id       uuid,
  p_cleaner_id   uuid,
  p_payout_cents integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_job jobs%rowtype;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return false; end if;
  if exists (select 1 from job_assignments where job_id = p_job_id) then
    return false;
  end if;

  -- The eligibility gate is enforced on offers by a CHECK (0003). A direct
  -- assignment bypasses the offers table entirely, so it has to ask the same
  -- question itself or the gate would have a hole exactly the width of every
  -- W-2 assignment the engine makes.
  if not cleaner_is_eligible(p_cleaner_id, p_job_id) then
    raise exception 'cleaner % is not eligible for job %', p_cleaner_id, p_job_id;
  end if;

  insert into job_assignments (job_id, cleaner_id, is_lead, payout_cents)
  values (p_job_id, p_cleaner_id, true, p_payout_cents);

  update jobs set status = 'assigned', dispatch_channel = 'direct_assign'
  where id = p_job_id;

  -- Any offer already out on this job stops existing.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = p_job_id and status = 'sent';

  return true;
end $$;

revoke all on function assign_job_directly(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function assign_job_directly(uuid, uuid, integer) to service_role;
