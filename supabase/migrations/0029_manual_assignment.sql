-- ============================================================================
-- 0029 — manual assignment from the management portal
--
-- Until now the only way a job got a cleaner was the dispatch sweep: W-2
-- cleaners assigned directly, contractors offered the job. The board showed
-- what the engine would do and gave the manager no way to act on it.
--
-- Two routes, split the same way the engine splits them:
--
--   * A W-2 cleaner is ASSIGNED (`assign_job_manually`). An employee is
--     scheduled, not asked.
--   * A contractor is OFFERED the job (`offer_job_manually`), exclusively, and
--     is only on it once she accepts. Scheduling a contractor without asking is
--     the control that makes her an employee whatever the paperwork says, so a
--     manager cannot do it either.
--
-- Both go through the eligibility gate (`cleaner_is_eligible`: active, rating
-- floor, background check, insurance, zone, not double-booked), and both are
-- recorded in dispatch_decisions with `decided_by` set: that column is the
-- numerator of the interventions metric (0015).
-- ============================================================================

alter table dispatch_decisions drop constraint if exists dispatch_decisions_kind_check;
alter table dispatch_decisions add constraint dispatch_decisions_kind_check
  check (kind in (
    'assign_guaranteed', 'assign_w2', 'hold_for_incumbent',
    'open_board', 'waterfall', 'no_eligible_cleaner', 'manual_assign', 'manual_offer'));

/**
 * Assign a W-2 cleaner to a job because a manager said so.
 *
 * Returns one of:
 *   'assigned'          done
 *   'not_found'         no such job
 *   'already_assigned'  somebody (the sweep, an accepted offer, another tab)
 *                       filled it first
 *   'closed'            the job is in progress, complete or canceled
 *   'ineligible'        the cleaner does not clear the gate for this job
 *   'contractor'        the cleaner is a contractor, who has to be offered the
 *                       job instead (offer_job_manually)
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
  if exists (select 1 from cleaners where id = p_cleaner_id and type = 'contractor_1099') then
    return 'contractor';
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

/**
 * Offer a job to one contractor because a manager chose her.
 *
 * The offer is exclusive: every other live offer on the job is withdrawn, and
 * the dispatch sweep leaves a job alone while a manager's offer on it is live
 * (see managerOffersFor in lib/dispatch/store.ts). She is on the job only when
 * she accepts, through respond_to_offer like any other offer; if she declines
 * or the countdown runs out, the sweep takes the job back.
 *
 * Returns (outcome, offer_id). Outcome is 'offered', or one of the refusals
 * assign_job_manually gives, or 'not_contractor' for a W-2 cleaner.
 */
create or replace function offer_job_manually(
  p_job_id       uuid,
  p_cleaner_id   uuid,
  p_share        numeric,
  p_payout_cents integer,
  p_expires_at   timestamptz,
  p_by           uuid
) returns table (outcome text, offer_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_job      jobs%rowtype;
  v_decision uuid;
  v_offer    uuid;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return query select 'not_found', null::uuid; return; end if;
  if v_job.status in ('in_progress', 'complete', 'canceled') then
    return query select 'closed', null::uuid; return;
  end if;
  if exists (select 1 from job_assignments where job_id = p_job_id) then
    return query select 'already_assigned', null::uuid; return;
  end if;
  if not exists (select 1 from cleaners where id = p_cleaner_id and type = 'contractor_1099') then
    return query select 'not_contractor', null::uuid; return;
  end if;
  if not cleaner_is_eligible(p_cleaner_id, p_job_id) then
    return query select 'ineligible', null::uuid; return;
  end if;

  -- Hers alone while she decides.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = p_job_id and status = 'sent' and cleaner_id <> p_cleaner_id;

  insert into dispatch_decisions (job_id, kind, cleaner_id, rationale, decided_by)
  values (p_job_id, 'manual_offer', p_cleaner_id, 'Offered by a manager.', p_by)
  returning id into v_decision;

  -- A live offer she already has is superseded, so the new one carries the
  -- manager's decision, payout and countdown.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = p_job_id and status = 'sent' and cleaner_id = p_cleaner_id;

  v_offer := record_offer(p_job_id, p_cleaner_id, v_decision, 'direct_assign', 1, p_share,
                          p_payout_cents, v_job.estimated_clean_minutes, p_expires_at, true);
  return query select 'offered', v_offer;
end $$;

revoke all on function offer_job_manually(uuid, uuid, numeric, integer, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function offer_job_manually(uuid, uuid, numeric, integer, timestamptz, uuid)
  to service_role;
