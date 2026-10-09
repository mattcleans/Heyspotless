-- Job locks arbitrate competing cleaners for one visit. A private cleaner
-- counter also serializes assignments to DIFFERENT visits, including crews
-- and retained assignments whose appointment window changes. Updating a real
-- row makes stale Repeatable Read writers fail with genuine SQLSTATE 40001.
create schema spotless_private;
revoke all on schema spotless_private from public,anon,authenticated,service_role;
create table spotless_private.cleaner_capacity (
 cleaner_id uuid primary key references public.cleaners(id) on delete cascade,
 revision bigint not null default 0
);
alter table spotless_private.cleaner_capacity enable row level security;
revoke all on spotless_private.cleaner_capacity from public,anon,authenticated,service_role;
insert into spotless_private.cleaner_capacity(cleaner_id) select id from public.cleaners;

create function spotless_private.lock_cleaner_capacity(p_cleaners uuid[]) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v_cleaner uuid;
begin
 for v_cleaner in select distinct x from unnest(p_cleaners) x where x is not null order by x loop
  -- A cascading cleaner deletion may already have removed its mutex. Do not
  -- recreate a child row for a deleted parent. New cleaners get a mutex here.
  if not exists(select 1 from public.cleaners where id=v_cleaner) then continue; end if;
  insert into spotless_private.cleaner_capacity(cleaner_id) values(v_cleaner)
   on conflict(cleaner_id) do nothing;
  update spotless_private.cleaner_capacity set revision=revision+1 where cleaner_id=v_cleaner;
 end loop;
end $$;
revoke all on function spotless_private.lock_cleaner_capacity(uuid[]) from public,anon,authenticated,service_role;

create function spotless_private.visit_capacity_window(p_start timestamptz,p_end timestamptz,p_minutes integer)
returns tstzrange language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
begin
 if p_start is null then return null; end if;
 if not isfinite(p_start) or (p_end is not null and not isfinite(p_end)) then
  raise exception 'Appointment needs a finite time' using errcode='22023';
 end if;
 return tstzrange(p_start,case when p_end>p_start then p_end
  else p_start+greatest(p_minutes,1)*interval '1 minute' end,'[)');
end $$;
revoke all on function spotless_private.visit_capacity_window(timestamptz,timestamptz,integer) from public,anon,authenticated,service_role;

create function spotless_private.assert_cleaner_capacity(p_cleaner uuid,p_job uuid,p_status public.job_status,
 p_start timestamptz,p_end timestamptz,p_minutes integer,p_exclude_assignment uuid default null)
returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v_window tstzrange;
begin
 if p_status in ('complete','canceled') then return; end if;
 v_window:=spotless_private.visit_capacity_window(p_start,p_end,p_minutes);
 -- An undated visit does not establish a known appointment window. Assigning
 -- a date later runs this same guard; this is not a promise of availability.
 if v_window is null then return; end if;
 if exists(select 1 from public.job_assignments a join public.jobs j on j.id=a.job_id
  where a.cleaner_id=p_cleaner and a.job_id<>p_job
   and (p_exclude_assignment is null or a.id<>p_exclude_assignment)
   and j.status not in ('complete','canceled') and j.scheduled_start is not null
   and spotless_private.visit_capacity_window(j.scheduled_start,j.scheduled_end,j.estimated_clean_minutes) && v_window) then
  raise exception 'Another accepted visit overlaps this appointment' using errcode='PCP01';
 end if;
end $$;
revoke all on function spotless_private.assert_cleaner_capacity(uuid,uuid,public.job_status,timestamptz,timestamptz,integer,uuid) from public,anon,authenticated,service_role;

create function public.guard_assignment_capacity() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype;v_old_job uuid;v_old_cleaner uuid;v_old_assignment uuid;
begin
 if tg_op<>'INSERT' then
  v_old_job:=old.job_id;v_old_cleaner:=old.cleaner_id;v_old_assignment:=old.id;
 end if;
 if tg_op='DELETE' then
  perform 1 from public.jobs where id=v_old_job for update;
  perform spotless_private.lock_cleaner_capacity(array[v_old_cleaner]);
  return old;
 end if;
 -- Existing choice/start writes use job -> cleaner order. Transfers lock both
 -- jobs and both cleaners in UUID order. Genuine deadlocks abort the write.
 perform 1 from public.jobs where id in (v_old_job,new.job_id) order by id for update;
 select * into j from public.jobs where id=new.job_id;
 if j.id is null then return new; end if; -- FK supplies the missing-job error.
 perform spotless_private.lock_cleaner_capacity(array[v_old_cleaner,new.cleaner_id]);
 perform spotless_private.assert_cleaner_capacity(new.cleaner_id,j.id,j.status,j.scheduled_start,
  j.scheduled_end,j.estimated_clean_minutes,v_old_assignment);
 return new;
end $$;
revoke all on function public.guard_assignment_capacity() from public,anon,authenticated,service_role;
create trigger assignment_00_capacity before insert or update of job_id,cleaner_id on public.job_assignments
 for each row execute function public.guard_assignment_capacity();
create trigger assignment_00_capacity_release before delete on public.job_assignments
 for each row execute function public.guard_assignment_capacity();

create function public.guard_visit_capacity() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_cleaners uuid[];v_cleaner uuid;
begin
 if new.scheduled_start is not distinct from old.scheduled_start
  and new.scheduled_end is not distinct from old.scheduled_end
  and new.estimated_clean_minutes is not distinct from old.estimated_clean_minutes
  and (new.status in ('complete','canceled'))=(old.status in ('complete','canceled')) then return new; end if;
 select array_agg(cleaner_id order by cleaner_id) into v_cleaners from public.job_assignments where job_id=new.id;
 perform spotless_private.lock_cleaner_capacity(v_cleaners);
 foreach v_cleaner in array coalesce(v_cleaners,array[]::uuid[]) loop
  perform spotless_private.assert_cleaner_capacity(v_cleaner,new.id,new.status,new.scheduled_start,
   new.scheduled_end,new.estimated_clean_minutes);
 end loop;
 return new;
end $$;
revoke all on function public.guard_visit_capacity() from public,anon,authenticated,service_role;
create trigger jobs_00_capacity before update of scheduled_start,scheduled_end,estimated_clean_minutes,status on public.jobs
 for each row execute function public.guard_visit_capacity();

alter table public.offers add column capacity_conflict_at timestamptz,
 add constraint offers_capacity_conflict_shape check(capacity_conflict_at is null or status='withdrawn');
-- Keep the original ownership, expiry, job/revision and accepted-pay semantics
-- in a private implementation. Both old and new entry points use the guard.
alter function public.respond_to_offer(uuid,uuid,boolean,text) set schema spotless_private;
alter function spotless_private.respond_to_offer(uuid,uuid,boolean,text) rename to respond_without_capacity_outcome;
alter function spotless_private.respond_without_capacity_outcome(uuid,uuid,boolean,text) set search_path=public,pg_temp;
revoke all on function spotless_private.respond_without_capacity_outcome(uuid,uuid,boolean,text) from public,anon,authenticated,service_role;
-- The original used transaction-start now(). A wait can outlive a countdown;
-- check the actual database clock after all locks, retaining its other logic.
do $expiry$
declare v_oid oid:='spotless_private.respond_without_capacity_outcome(uuid,uuid,boolean,text)'::regprocedure;v_definition text;
begin
 v_definition:=pg_get_functiondef(v_oid);
 if position('v_offer.expires_at <= now()' in v_definition)=0 then raise exception 'Expected offer expiry guard absent';end if;
 execute replace(v_definition,'v_offer.expires_at <= now()','v_offer.expires_at <= clock_timestamp()');
end
$expiry$;
create function public.respond_to_offer(p_offer_id uuid,p_cleaner_id uuid,p_accept boolean,p_reason text default null)
returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_job uuid;v_conflicted boolean;v_initial_sent boolean;j public.jobs%rowtype;o public.offers%rowtype;
begin
 select job_id,status='withdrawn' and capacity_conflict_at is not null,status='sent' into v_job,v_conflicted,v_initial_sent
  from public.offers where id=p_offer_id and cleaner_id=p_cleaner_id;
 if v_job is null then return 'not_found'; end if;
 if v_conflicted then return 'conflict'; end if;
 -- Retain this lock outside the subtransaction: a capacity conflict rolls
 -- back the attempted acceptance, while withdrawing the offer commits once.
 perform 1 from public.jobs where id=v_job for update;
 if exists(select 1 from public.offers where id=p_offer_id and cleaner_id=p_cleaner_id
  and status='withdrawn' and capacity_conflict_at is not null) then return 'conflict'; end if;
 begin
  select * into j from public.jobs where id=v_job;
  select * into o from public.offers where id=p_offer_id and cleaner_id=p_cleaner_id;
  -- Preserve the original same-job race: a sent offer read before waiting is
  -- 'taken' when another cleaner wins under the job lock. Already-stale
  -- withdrawn offers retain the original 'superseded' result.
  if v_initial_sent and p_accept and o.status='withdrawn' and j.status='assigned'
   and exists(select 1 from public.job_assignments where job_id=j.id) then return 'taken'; end if;
  if p_accept and o.status='sent' and o.expires_at>clock_timestamp()
   and j.status in ('unscheduled','scheduled','dispatching') and j.started_at is null
   and not exists(select 1 from public.job_assignments where job_id=j.id) then
   -- Check before the existing eligibility CHECK on the accepted offer. This
   -- gives both stored-end and estimated-end conflicts the same honest result.
   perform spotless_private.lock_cleaner_capacity(array[p_cleaner_id]);
   select * into o from public.offers where id=p_offer_id and cleaner_id=p_cleaner_id;
   if o.status='sent' and o.expires_at>clock_timestamp() then
    perform spotless_private.assert_cleaner_capacity(p_cleaner_id,j.id,j.status,j.scheduled_start,
     j.scheduled_end,j.estimated_clean_minutes);
   end if;
  end if;
  return spotless_private.respond_without_capacity_outcome(p_offer_id,p_cleaner_id,p_accept,p_reason);
 exception when sqlstate 'PCP01' then
  update public.offers set status='withdrawn',responded_at=clock_timestamp(),capacity_conflict_at=clock_timestamp()
   where id=p_offer_id and cleaner_id=p_cleaner_id and status='sent';
  return 'conflict';
 end;
end $$;
revoke all on function public.respond_to_offer(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.respond_to_offer(uuid,uuid,boolean,text) to service_role;
-- Fail closed on an older database instead of silently accepting unguarded.
create function public.respond_to_offer_with_capacity(p_offer_id uuid,p_cleaner_id uuid,p_accept boolean,p_reason text default null)
returns text language sql set search_path=pg_catalog,pg_temp as $$
 select public.respond_to_offer(p_offer_id,p_cleaner_id,p_accept,p_reason)
$$;
revoke all on function public.respond_to_offer_with_capacity(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.respond_to_offer_with_capacity(uuid,uuid,boolean,text) to service_role;

create function public.assign_job_for_schedule_with_capacity(p_job_id uuid,p_cleaner_id uuid,p_payout_cents integer,p_schedule_revision bigint)
returns boolean language sql set search_path=pg_catalog,pg_temp as $$
 select public.assign_job_for_schedule(p_job_id,p_cleaner_id,p_payout_cents,p_schedule_revision)
$$;
revoke all on function public.assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint) from public,anon,authenticated;
grant execute on function public.assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint) to service_role;
