-- Keep unscheduled/overdue work visible without offering an unusable appointment.
alter table public.dispatch_decisions drop constraint dispatch_decisions_kind_check;
alter table public.dispatch_decisions add constraint dispatch_decisions_kind_check
 check(kind in ('assign_guaranteed','assign_w2','hold_for_incumbent','open_board','waterfall','no_eligible_cleaner','needs_scheduling'));

-- These are the sweep's revision-bound entry points. Legacy history and
-- manual correction paths are retained; automatic writes need a future time.
create or replace function public.record_offer_for_schedule(p_job_id uuid,p_cleaner_id uuid,p_decision_id uuid,p_channel public.dispatch_channel,
 p_tier integer,p_share numeric,p_payout_cents integer,p_estimated_minutes integer,p_expires_at timestamptz,p_is_exclusive boolean,p_schedule_revision bigint)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $offer$
declare j public.jobs%rowtype;
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or p_schedule_revision is null or j.schedule_revision<>p_schedule_revision
  or j.status not in ('unscheduled','scheduled','dispatching') or j.started_at is not null
  or j.scheduled_start is null or not isfinite(j.scheduled_start) or j.scheduled_start<=clock_timestamp() then return null;end if;
 return public.record_offer(p_job_id,p_cleaner_id,p_decision_id,p_channel,p_tier,p_share,p_payout_cents,p_estimated_minutes,
  case when p_expires_at is null then null else least(p_expires_at,j.scheduled_start) end,p_is_exclusive);
end $offer$;
create or replace function public.assign_job_for_schedule(p_job_id uuid,p_cleaner_id uuid,p_payout_cents integer,p_schedule_revision bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $assignment$
declare j public.jobs%rowtype;
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or p_schedule_revision is null or j.schedule_revision<>p_schedule_revision
  or j.status not in ('unscheduled','scheduled','dispatching') or j.started_at is not null
  or j.scheduled_start is null or not isfinite(j.scheduled_start) or j.scheduled_start<=clock_timestamp() then return false;end if;
 return public.assign_job_directly(p_job_id,p_cleaner_id,p_payout_cents);
end $assignment$;
revoke all on function public.record_offer_for_schedule(uuid,uuid,uuid,public.dispatch_channel,integer,numeric,integer,integer,timestamptz,boolean,bigint),
 public.assign_job_for_schedule(uuid,uuid,integer,bigint) from public,anon,authenticated;
grant execute on function public.record_offer_for_schedule(uuid,uuid,uuid,public.dispatch_channel,integer,numeric,integer,integer,timestamptz,boolean,bigint),
 public.assign_job_for_schedule(uuid,uuid,integer,bigint) to service_role;

-- The existing responder already holds the job lock and preserves taken,
-- accepted-retry, decline, schedule-revision and capacity outcomes. Add the
-- time check after its taken branch, before a still-current offer is accepted.
do $guard$
declare definition text;marker text := $marker$  if p_accept and o.status='sent' and o.expires_at>clock_timestamp()
   and j.status in ('unscheduled','scheduled','dispatching') and j.started_at is null$marker$;
 addition text := $body$  if p_accept and o.status='sent' and o.schedule_revision=j.schedule_revision
   and j.status in ('unscheduled','scheduled','dispatching') and j.started_at is null
   and (j.scheduled_start is null or not isfinite(j.scheduled_start) or j.scheduled_start<=clock_timestamp()) then
   update public.offers set status='expired',responded_at=clock_timestamp()
    where id=p_offer_id and cleaner_id=p_cleaner_id and status='sent';
   return 'expired';
  end if;
$body$;
begin
 definition:=pg_get_functiondef('public.respond_to_offer(uuid,uuid,boolean,text)'::regprocedure);
 if array_length(string_to_array(definition,marker),1)<>2 then raise exception 'Expected locked capacity responder marker absent';end if;
 execute replace(definition,marker,addition||marker);
end $guard$;
