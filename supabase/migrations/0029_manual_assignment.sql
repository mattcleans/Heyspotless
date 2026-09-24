-- ============================================================================
-- 0029 — manual assignment from the management portal
--
-- Until now the only way a job got a cleaner was the dispatch sweep: W-2
-- cleaners assigned directly, contractors offered the job. The board showed
-- what the engine would do and gave the manager no way to act on it.
--
-- This lets an admin assign ANY eligible cleaner — W-2 or contractor — straight
-- onto a job. That is an owner decision, made knowingly: a contractor assigned
-- this way is scheduled rather than asked.
--
-- The eligibility gate still applies. "Anyone" means anyone who clears
-- `cleaner_is_eligible` (active, rating floor, background check, insurance,
-- zone, not double-booked) — the same gate the offers table enforces, so a
-- manual assignment cannot put an uncleared person in somebody's home.
--
-- Every manual assignment is recorded in dispatch_decisions with `decided_by`
-- set: that column is the numerator of the interventions metric (0015).
-- ============================================================================

alter table dispatch_decisions drop constraint if exists dispatch_decisions_kind_check;
alter table dispatch_decisions add constraint dispatch_decisions_kind_check
  check (kind in (
    'assign_guaranteed', 'assign_w2', 'hold_for_incumbent',
    'open_board', 'waterfall', 'no_eligible_cleaner', 'manual_assign'));

/**
 * Assign a cleaner to a job because a manager said so.
 *
 * Returns one of:
 *   'assigned'          done
 *   'not_found'         no such job
 *   'already_assigned'  somebody (the sweep, an accepted offer, another tab)
 *                       filled it first
 *   'closed'            the job is in progress, complete or canceled
 *   'ineligible'        the cleaner does not clear the gate for this job
 *
 * Service-role only. The API route proves the caller is an admin and passes
 * their profile id as p_by.
 */
create or replace function assign_job_manually(
  p_job_id       uuid,
  p_cleaner_id   uuid,
  p_payout_cents integer,
  p_by           uuid
) returns text
language plpgsql security definer set search_path = public as $$
declare v_job jobs%rowtype;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return 'not_found'; end if;
  if v_job.status in ('in_progress', 'complete', 'canceled') then return 'closed'; end if;
  if exists (select 1 from job_assignments where job_id = p_job_id) then
    return 'already_assigned';
  end if;
  if not cleaner_is_eligible(p_cleaner_id, p_job_id) then return 'ineligible'; end if;

  insert into job_assignments (job_id, cleaner_id, is_lead, payout_cents)
  values (p_job_id, p_cleaner_id, true, p_payout_cents);

  update jobs set status = 'assigned', dispatch_channel = 'direct_assign'
  where id = p_job_id;

  -- Anything already out on this job stops existing.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = p_job_id and status = 'sent';

  insert into dispatch_decisions (job_id, kind, cleaner_id, rationale, decided_by)
  values (p_job_id, 'manual_assign', p_cleaner_id, 'Assigned by a manager.', p_by);

  return 'assigned';
end $$;

revoke all on function assign_job_manually(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function assign_job_manually(uuid, uuid, integer, uuid) to service_role;
