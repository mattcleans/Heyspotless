-- A reschedule keeps the same visit and recurring occurrence. It never bills
-- a cancellation fee and never treats the old cleaner's acceptance as consent
-- to a different appointment.
alter table jobs add column schedule_revision bigint not null default 1 check(schedule_revision>0);
alter table offers add column schedule_revision bigint not null default 1;
alter table visit_cancellation_quotes add column schedule_revision bigint not null default 1;

create function bump_visit_schedule_revision() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if row(new.scheduled_start,new.scheduled_end,new.customer_id,new.property_id,new.service,new.freq,new.price_cents,new.estimated_clean_minutes,new.preferred_cleaner_id)
  is distinct from row(old.scheduled_start,old.scheduled_end,old.customer_id,old.property_id,old.service,old.freq,old.price_cents,old.estimated_clean_minutes,old.preferred_cleaner_id) then
  new.schedule_revision:=old.schedule_revision+1;
 else new.schedule_revision:=old.schedule_revision; end if;
 return new;
end $$;
create trigger jobs_schedule_revision before update on jobs for each row execute function bump_visit_schedule_revision();
revoke all on function bump_visit_schedule_revision() from public,anon,authenticated;

-- Capture the cancellation review's identity even if an appointment moves
-- away and back to the exact same time before an old review is confirmed.
create function stamp_cancellation_schedule() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='visit_cancellation_quotes' then
  select schedule_revision into new.schedule_revision from jobs where id=new.job_id;
 else
  if (select q.schedule_revision from visit_cancellation_quotes q where q.id=new.id)
     is distinct from (select j.schedule_revision from jobs j where j.id=new.job_id) then
   raise exception 'appointment changed since cancellation review' using errcode='40001';
  end if;
 end if;
 return new;
end $$;
create trigger cancellation_quote_schedule before insert on visit_cancellation_quotes for each row execute function stamp_cancellation_schedule();
create trigger cancellation_receipt_schedule before insert on visit_cancellations for each row execute function stamp_cancellation_schedule();
revoke all on function stamp_cancellation_schedule() from public,anon,authenticated;

create table visit_reschedule_quotes (
 id uuid primary key default uuid_generate_v4(),
 job_id uuid not null references jobs(id),
 customer_id uuid not null references customers(id),
 requested_by uuid not null references profiles(id),
 schedule_revision bigint not null,
 recurring_plan_id uuid references recurring_plans(id),
 occurrence_date date,
 previous_start timestamptz,
 previous_end timestamptz,
 new_start timestamptz not null,
 new_end timestamptz not null,
 price_cents integer not null,
 assignment_snapshot jsonb not null,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create table visit_reschedules (
 id uuid primary key references visit_reschedule_quotes(id),
 version bigint generated always as identity,
 job_id uuid not null references jobs(id),
 customer_id uuid not null references customers(id),
 confirmed_by uuid not null references profiles(id),
 previous_start timestamptz,
 new_start timestamptz not null,
 new_end timestamptz not null,
 price_cents integer not null,
 fee_cents integer not null default 0 check(fee_cents=0),
 released_count integer not null,
 confirmed_at timestamptz not null default now()
);
create index on visit_reschedules(job_id,version desc);
-- Separate private agreed-pay snapshots from the client-visible receipt.
create table visit_reschedule_releases (
 id uuid primary key, -- former assignment id: immutable even after deletion
 reschedule_id uuid not null references visit_reschedules(id),
 job_id uuid not null references jobs(id),
 cleaner_id uuid not null references cleaners(id),
 offer_id uuid references offers(id),
 payout_cents integer not null,
 is_lead boolean not null,
 assigned_at timestamptz not null,
 previous_start timestamptz,
 new_start timestamptz not null,
 released_at timestamptz not null default now()
);
create index on visit_reschedule_releases(cleaner_id,released_at desc);
alter table visit_reschedule_quotes enable row level security;
alter table visit_reschedules enable row level security;
alter table visit_reschedule_releases enable row level security;
create policy reschedule_quotes_read on visit_reschedule_quotes for select to authenticated using(requested_by=auth.uid() and (is_admin() or customer_id=current_customer_id()));
create policy reschedules_read on visit_reschedules for select to authenticated using(is_admin() or (current_role_of()='customer' and exists(select 1 from jobs j where j.id=job_id and j.customer_id=current_customer_id())));
create policy reschedule_releases_read on visit_reschedule_releases for select to authenticated using(is_admin() or (current_role_of()='cleaner' and cleaner_id=current_cleaner_id()));
revoke all on visit_reschedule_quotes,visit_reschedules,visit_reschedule_releases from public,anon,authenticated;
-- Quotes carry assignment/pay snapshots and are accessible only through the
-- sanitized RPC, not base-table SELECT for clients.
grant select on visit_reschedules,visit_reschedule_releases to authenticated;
grant all on visit_reschedule_quotes,visit_reschedules,visit_reschedule_releases to service_role;

create function visit_assignment_snapshot(p_job_id uuid) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from job_assignments a where a.job_id=p_job_id
$$;
revoke all on function visit_assignment_snapshot(uuid) from public,anon,authenticated;

create function quote_my_visit_reschedule(p_job_id uuid,p_new_start timestamptz) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype; q visit_reschedule_quotes%rowtype; v_duration interval;
begin
 if not is_admin() and (current_role_of() is distinct from 'customer' or current_customer_id() is null) then raise insufficient_privilege; end if;
 select * into j from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id()) for update;
 if j.id is null then raise insufficient_privilege; end if;
 if j.status not in ('unscheduled','scheduled','dispatching','assigned') or j.started_at is not null
   or exists(select 1 from time_entries where job_id=j.id) then raise exception 'visit already started or closed' using errcode='40001'; end if;
 if p_new_start is null or not isfinite(p_new_start) or p_new_start<=clock_timestamp() or
  p_new_start>clock_timestamp()+interval '366 days' or date_trunc('minute',p_new_start)<>p_new_start or
  p_new_start is not distinct from j.scheduled_start then raise invalid_parameter_value; end if;
 v_duration:=case when j.scheduled_end>j.scheduled_start then j.scheduled_end-j.scheduled_start
  else greatest(j.estimated_clean_minutes,1)*interval '1 minute' end;
 insert into visit_reschedule_quotes(job_id,customer_id,requested_by,schedule_revision,recurring_plan_id,occurrence_date,
  previous_start,previous_end,new_start,new_end,price_cents,assignment_snapshot,expires_at)
 values(j.id,j.customer_id,auth.uid(),j.schedule_revision,j.recurring_plan_id,j.occurrence_date,j.scheduled_start,j.scheduled_end,
  p_new_start,p_new_start+v_duration,j.price_cents,visit_assignment_snapshot(j.id),clock_timestamp()+interval '5 minutes') returning * into q;
 return jsonb_build_object('id',q.id,'job_id',q.job_id,'previous_start',q.previous_start,'new_start',q.new_start,
  'new_end',q.new_end,'price_cents',q.price_cents,'fee_cents',0,'released_count',jsonb_array_length(q.assignment_snapshot),'expires_at',q.expires_at);
end $$;

create function confirm_my_visit_reschedule(p_job_id uuid,p_quote_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype; q visit_reschedule_quotes%rowtype; r visit_reschedules%rowtype; v_plan uuid;
begin
 if not is_admin() and (current_role_of() is distinct from 'customer' or current_customer_id() is null) then raise insufficient_privilege; end if;
 -- Same lock order as cancellation and recurring materialisation.
 select recurring_plan_id into v_plan from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id());
 if v_plan is not null then perform 1 from recurring_plans where id=v_plan for update; end if;
 select * into j from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id()) for update;
 if j.id is null then raise insufficient_privilege; end if;
 select * into q from visit_reschedule_quotes where id=p_quote_id and job_id=j.id and customer_id=j.customer_id and requested_by=auth.uid();
 if q.id is null then raise insufficient_privilege; end if;
 select * into r from visit_reschedules where id=q.id;
 if r.id is not null then return to_jsonb(r); end if;
 if j.status not in ('unscheduled','scheduled','dispatching','assigned') or j.started_at is not null
  or exists(select 1 from time_entries where job_id=j.id) or q.expires_at<=clock_timestamp() or q.new_start<=clock_timestamp()
  or q.schedule_revision<>j.schedule_revision or j.recurring_plan_id is distinct from v_plan
  or q.recurring_plan_id is distinct from j.recurring_plan_id or q.occurrence_date is distinct from j.occurrence_date
  or q.assignment_snapshot<>visit_assignment_snapshot(j.id) then
  raise exception 'appointment changed since review' using errcode='40001';
 end if;
 insert into visit_reschedules(id,job_id,customer_id,confirmed_by,previous_start,new_start,new_end,price_cents,released_count)
 values(q.id,j.id,j.customer_id,auth.uid(),q.previous_start,q.new_start,q.new_end,q.price_cents,jsonb_array_length(q.assignment_snapshot)) returning * into r;
 insert into visit_reschedule_releases(id,reschedule_id,job_id,cleaner_id,offer_id,payout_cents,is_lead,assigned_at,previous_start,new_start)
 select a.id,r.id,j.id,a.cleaner_id,a.offer_id,a.payout_cents,a.is_lead,a.assigned_at,j.scheduled_start,q.new_start from job_assignments a where a.job_id=j.id;
 update offers set status='withdrawn',responded_at=now() where job_id=j.id and status in ('sent','accepted');
 delete from job_assignments where job_id=j.id;
 update jobs set scheduled_start=q.new_start,scheduled_end=q.new_end,status='scheduled',dispatch_channel=null where id=j.id;
 -- Keep preference requests, exclusions, photos, invoices and occurrence_date.
 -- Backup decisions retain assignment_key; the next assignment has a new ID.
 return to_jsonb(r);
end $$;
revoke all on function quote_my_visit_reschedule(uuid,timestamptz),confirm_my_visit_reschedule(uuid,uuid) from public,anon;
grant execute on function quote_my_visit_reschedule(uuid,timestamptz),confirm_my_visit_reschedule(uuid,uuid) to authenticated;

-- Offers are valid for one appointment revision. Their private history remains
-- intact; withdrawn/old-revision offers cannot claim the moved appointment.
create or replace function guard_open_visit_offer() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype;
begin
 if tg_op='INSERT' or (new.status in ('sent','accepted') and new.status is distinct from old.status) then
  select * into v_job from jobs where id=new.job_id for update;
  if tg_op='INSERT' then new.schedule_revision:=v_job.schedule_revision; end if;
  if new.status in ('sent','accepted') and (v_job.status not in ('unscheduled','scheduled','dispatching')
   or v_job.started_at is not null or exists(select 1 from job_assignments where job_id=new.job_id)
   or new.schedule_revision<>v_job.schedule_revision) then
   raise exception 'visit no longer open for this offer' using errcode='23514';
  end if;
 end if;
 return new;
end $$;

-- The sweep carries the revision it read into its write, under the same job
-- lock as rescheduling. No offer/assignment is written from an old schedule.
create function record_offer_for_schedule(p_job_id uuid,p_cleaner_id uuid,p_decision_id uuid,p_channel dispatch_channel,
 p_tier integer,p_share numeric,p_payout_cents integer,p_estimated_minutes integer,p_expires_at timestamptz,p_is_exclusive boolean,p_schedule_revision bigint)
 returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype;
begin
 select * into j from jobs where id=p_job_id for update;
 if j.id is null or p_schedule_revision is null or j.schedule_revision<>p_schedule_revision
  or j.status not in ('unscheduled','scheduled','dispatching') or j.started_at is not null then return null; end if;
 return record_offer(p_job_id,p_cleaner_id,p_decision_id,p_channel,p_tier,p_share,p_payout_cents,p_estimated_minutes,p_expires_at,p_is_exclusive);
end $$;
create function assign_job_for_schedule(p_job_id uuid,p_cleaner_id uuid,p_payout_cents integer,p_schedule_revision bigint)
 returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype;
begin
 select * into j from jobs where id=p_job_id for update;
 if j.id is null or p_schedule_revision is null or j.schedule_revision<>p_schedule_revision
  or j.status not in ('unscheduled','scheduled','dispatching') or j.started_at is not null then return false; end if;
 return assign_job_directly(p_job_id,p_cleaner_id,p_payout_cents);
end $$;
revoke all on function record_offer_for_schedule(uuid,uuid,uuid,dispatch_channel,integer,numeric,integer,integer,timestamptz,boolean,bigint),assign_job_for_schedule(uuid,uuid,integer,bigint) from public,anon,authenticated;
grant execute on function record_offer_for_schedule(uuid,uuid,uuid,dispatch_channel,integer,numeric,integer,integer,timestamptz,boolean,bigint),assign_job_for_schedule(uuid,uuid,integer,bigint) to service_role;
