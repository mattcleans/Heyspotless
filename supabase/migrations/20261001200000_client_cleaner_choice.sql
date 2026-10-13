-- Clients request a preference; the office applies it to matching. An actual
-- backup assignment requires that client's approval before starting work.
create table visit_cleaner_requests (
  id uuid primary key,
  version bigint generated always as identity,
  job_id uuid not null references jobs(id),
  customer_id uuid not null references customers(id),
  cleaner_id uuid not null references cleaners(id),
  cleaner_name text not null,
  requested_by uuid not null references profiles(id),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'pending' check (status in ('pending','applied','declined','withdrawn')),
  decision_note text check (length(decision_note) <= 500),
  reviewed_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index one_pending_cleaner_request on visit_cleaner_requests(job_id) where status='pending';
create index on visit_cleaner_requests(job_id,version desc);
alter table visit_cleaner_requests enable row level security;
create policy cleaner_requests_client on visit_cleaner_requests for select using(current_role_of()='customer' and customer_id=current_customer_id());
create policy cleaner_requests_admin on visit_cleaner_requests for select using(is_admin());
revoke all on visit_cleaner_requests from public,anon,authenticated;
grant select on visit_cleaner_requests to authenticated;
grant all on visit_cleaner_requests to service_role;

create table visit_backup_decisions (
  id uuid primary key,
  version bigint generated always as identity,
  job_id uuid not null references jobs(id),
  assignment_id uuid references job_assignments(id) on delete set null,
  assignment_key uuid not null, -- immutable identity for receipts after release
  customer_id uuid not null references customers(id),
  preferred_cleaner_id uuid not null references cleaners(id),
  backup_cleaner_id uuid not null references cleaners(id),
  accepted boolean not null,
  note text not null default '' check(length(note)<=500),
  decided_by uuid not null references profiles(id),
  decided_at timestamptz not null default now()
);
create index on visit_backup_decisions(job_id,assignment_id,preferred_cleaner_id,backup_cleaner_id,version desc);
alter table visit_backup_decisions enable row level security;
create policy backup_decisions_client on visit_backup_decisions for select using(
  current_role_of()='customer' and exists(select 1 from jobs j where j.id=job_id and j.customer_id=current_customer_id()));
create policy backup_decisions_admin on visit_backup_decisions for select using(is_admin());
revoke all on visit_backup_decisions from public,anon,authenticated;
grant select on visit_backup_decisions to authenticated;
grant all on visit_backup_decisions to service_role;

-- Base assignments include private pay. Explicitly publish only the fields
-- needed to identify who is attending an OWN visit, never a base-table policy.
create view client_visit_assignments as
select a.id,a.job_id,a.cleaner_id,c.full_name,a.is_lead,a.assigned_at
from job_assignments a join jobs j on j.id=a.job_id join cleaners c on c.id=a.cleaner_id
where is_admin() or (current_role_of()='customer' and j.customer_id=current_customer_id())
  or (current_role_of()='cleaner' and a.cleaner_id=current_cleaner_id());
revoke all on client_visit_assignments from public,anon;
grant select on client_visit_assignments to authenticated,service_role;

create function request_my_visit_cleaner(p_job_id uuid,p_cleaner_id uuid,p_id uuid,p_note text,p_expected_latest uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_old visit_cleaner_requests%rowtype; v_latest uuid; v_out visit_cleaner_requests%rowtype;
begin
  if current_role_of() is distinct from 'customer' or current_customer_id() is null then raise insufficient_privilege; end if;
  select * into v_job from jobs where id=p_job_id and customer_id=current_customer_id() for update;
  if v_job.id is null then raise insufficient_privilege; end if;
  if p_id is null or p_cleaner_id is null or p_note is null or length(p_note)>500 then raise invalid_parameter_value; end if;
  select * into v_old from visit_cleaner_requests where id=p_id;
  if v_old.id is not null then
    if v_old.job_id<>p_job_id or v_old.requested_by<>auth.uid() or v_old.cleaner_id<>p_cleaner_id or v_old.note<>trim(p_note) then raise insufficient_privilege; end if;
    return to_jsonb(v_old);
  end if;
  if v_job.started_at is not null or v_job.status in ('in_progress','complete','canceled') then raise exception using errcode='40001',message='Visit already started or closed'; end if;
  if not exists(select 1 from cleaner_profiles c join properties p on p.id=v_job.property_id
    where c.id=p_cleaner_id and (cardinality(c.service_zips)=0 or p.zip=any(c.service_zips))) then raise invalid_parameter_value; end if;
  select id into v_latest from visit_cleaner_requests where job_id=p_job_id order by version desc limit 1;
  if v_latest is distinct from p_expected_latest then raise exception using errcode='40001',message='Cleaner request changed'; end if;
  update visit_cleaner_requests set status='withdrawn',reviewed_at=now() where job_id=p_job_id and status='pending';
  insert into visit_cleaner_requests(id,job_id,customer_id,cleaner_id,cleaner_name,requested_by,note)
    values(p_id,p_job_id,v_job.customer_id,p_cleaner_id,(select full_name from cleaner_profiles where id=p_cleaner_id),auth.uid(),trim(p_note)) returning * into v_out;
  return to_jsonb(v_out);
end $$;

create function review_visit_cleaner_request(p_id uuid,p_apply boolean,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_req visit_cleaner_requests%rowtype; v_job_id uuid;
begin
  if not is_admin() then raise insufficient_privilege; end if;
  select job_id into v_job_id from visit_cleaner_requests where id=p_id;
  select * into v_job from jobs where id=v_job_id for update;
  select * into v_req from visit_cleaner_requests where id=p_id for update;
  if v_req.id is null then raise invalid_parameter_value; end if;
  if p_apply is null or p_note is null or length(trim(p_note))=0 or length(p_note)>500 then raise invalid_parameter_value; end if;
  if v_req.status<>'pending' then
    if v_req.status=(case when p_apply then 'applied' else 'declined' end) and v_req.reviewed_by=auth.uid() and v_req.decision_note=trim(p_note) then return to_jsonb(v_req); end if;
    raise exception using errcode='40001',message='Request was already reviewed';
  end if;
  if p_apply then
    if v_job.started_at is not null or v_job.status not in ('unscheduled','scheduled','dispatching')
      or exists(select 1 from job_assignments where job_id=v_job.id)
      or exists(select 1 from offers where job_id=v_job.id and status='sent' and expires_at>now()) then
      raise exception using errcode='40001',message='Resolve current assignment or offers before changing matching';
    end if;
    delete from visit_cleaner_exclusions where job_id=v_job.id and cleaner_id=v_req.cleaner_id;
    if not cleaner_is_eligible(v_req.cleaner_id,v_job.id) then raise exception using errcode='23514',message='Requested cleaner is not currently eligible'; end if;
    update jobs set preferred_cleaner_id=v_req.cleaner_id where id=v_job.id;
  end if;
  update visit_cleaner_requests set status=case when p_apply then 'applied' else 'declined' end,
    reviewed_by=auth.uid(),reviewed_at=now(),decision_note=trim(p_note) where id=p_id returning * into v_req;
  return to_jsonb(v_req);
end $$;

create function respond_my_visit_backup(p_job_id uuid,p_assignment_id uuid,p_preferred_cleaner_id uuid,p_backup_cleaner_id uuid,
  p_id uuid,p_accept boolean,p_note text,p_expected_latest uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_assignment job_assignments%rowtype; v_old visit_backup_decisions%rowtype; v_latest uuid; v_out visit_backup_decisions%rowtype;
begin
  if current_role_of() is distinct from 'customer' or current_customer_id() is null then raise insufficient_privilege; end if;
  select * into v_job from jobs where id=p_job_id and customer_id=current_customer_id() for update;
  if v_job.id is null then raise insufficient_privilege; end if;
  if p_id is null or p_accept is null or p_note is null or length(p_note)>500 then raise invalid_parameter_value; end if;
  select * into v_old from visit_backup_decisions where id=p_id;
  if v_old.id is not null then
    if v_old.job_id<>p_job_id or v_old.assignment_key is distinct from p_assignment_id or v_old.preferred_cleaner_id is distinct from p_preferred_cleaner_id
      or v_old.backup_cleaner_id is distinct from p_backup_cleaner_id
      or v_old.decided_by<>auth.uid() or v_old.accepted<>p_accept or v_old.note<>trim(p_note) then raise insufficient_privilege; end if;
    return to_jsonb(v_old);
  end if;
  select * into v_assignment from job_assignments where id=p_assignment_id and job_id=p_job_id and is_lead;
  if v_assignment.id is null or v_job.preferred_cleaner_id is null or v_job.preferred_cleaner_id is distinct from p_preferred_cleaner_id
    or v_assignment.cleaner_id is distinct from p_backup_cleaner_id or v_assignment.cleaner_id=v_job.preferred_cleaner_id
    or (select count(*) from job_assignments where job_id=p_job_id and is_lead)<>1 then
    raise exception using errcode='40001',message='Backup assignment changed';
  end if;
  if v_job.status<>'assigned' or v_job.started_at is not null then raise exception using errcode='40001',message='Visit already started or closed'; end if;
  select id into v_latest from visit_backup_decisions where job_id=p_job_id and customer_id=v_job.customer_id and decided_by=(select profile_id from customers where id=v_job.customer_id) and assignment_id=p_assignment_id
    and preferred_cleaner_id=p_preferred_cleaner_id and backup_cleaner_id=v_assignment.cleaner_id order by version desc limit 1;
  if v_latest is distinct from p_expected_latest then raise exception using errcode='40001',message='Backup decision changed'; end if;
  insert into visit_backup_decisions(id,job_id,assignment_id,assignment_key,customer_id,preferred_cleaner_id,backup_cleaner_id,accepted,note,decided_by)
    values(p_id,p_job_id,p_assignment_id,p_assignment_id,v_job.customer_id,p_preferred_cleaner_id,v_assignment.cleaner_id,p_accept,trim(p_note),auth.uid()) returning * into v_out;
  return to_jsonb(v_out);
end $$;

-- Safe status for the assigned cleaner. Client notes and profile IDs stay private.
create view visit_backup_status as
select j.id as job_id,j.status as job_status,j.started_at,
  (select first_name||' '||last_name from customers where id=j.customer_id) as customer_name,
  (select street from properties where id=j.property_id) as street,
  (select city from properties where id=j.property_id) as city,
  a.id as assignment_id,a.cleaner_id as backup_cleaner_id,j.preferred_cleaner_id,
  (select full_name from cleaners where id=a.cleaner_id) as backup_name,
  (select full_name from cleaners where id=j.preferred_cleaner_id) as preferred_name,
  d.id as decision_id,coalesce(d.accepted,false) as approved,d.decided_at,
  (select count(*) from job_assignments t where t.job_id=j.id and t.is_lead)=1 as unambiguous,
  (select count(*) from job_assignments t where t.job_id=j.id)=1 as release_allowed
from jobs j join job_assignments a on a.job_id=j.id and a.is_lead
left join lateral (select b.id,b.accepted,b.decided_at from visit_backup_decisions b
  where b.job_id=j.id and b.customer_id=j.customer_id and b.decided_by=(select profile_id from customers where id=j.customer_id) and b.assignment_id=a.id and b.preferred_cleaner_id=j.preferred_cleaner_id and b.backup_cleaner_id=a.cleaner_id
  order by b.version desc limit 1) d on true
where j.preferred_cleaner_id is not null and a.cleaner_id<>j.preferred_cleaner_id
  and (is_admin() or (current_role_of()='customer' and j.customer_id=current_customer_id()) or (current_role_of()='cleaner' and exists(select 1 from job_assignments own where own.job_id=j.id and own.cleaner_id=current_cleaner_id())));
revoke all on visit_backup_status from public,anon;
grant select on visit_backup_status to authenticated,service_role;

create function require_client_backup_approval() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.preferred_cleaner_id is not null and old.started_at is null
    and old.status not in ('in_progress','complete','canceled')
    and (new.started_at is not null or new.status in ('in_progress','complete')) then
    if (select count(*) from job_assignments where job_id=new.id and is_lead)<>1 then
      raise exception using errcode='PBC01',message='Confirm the lead cleaner before work starts';
    end if;
    if exists(select 1 from job_assignments a where a.job_id=new.id and a.is_lead
      and a.cleaner_id<>new.preferred_cleaner_id
      and not coalesce((select b.accepted from visit_backup_decisions b where b.job_id=new.id and b.customer_id=new.customer_id and b.decided_by=(select profile_id from customers where id=new.customer_id) and b.assignment_id=a.id
        and b.preferred_cleaner_id=new.preferred_cleaner_id and b.backup_cleaner_id=a.cleaner_id order by b.version desc limit 1),false)) then
    raise exception using errcode='PBC01',message='Client approval is required for this backup before work starts';
    end if;
  end if;
  return new;
end $$;
create trigger client_approves_backup_before_start before update of status,started_at on jobs
for each row execute function require_client_backup_approval();

revoke all on function request_my_visit_cleaner(uuid,uuid,uuid,text,uuid),review_visit_cleaner_request(uuid,boolean,text),respond_my_visit_backup(uuid,uuid,uuid,uuid,uuid,boolean,text,uuid),require_client_backup_approval() from public,anon,authenticated;
grant execute on function request_my_visit_cleaner(uuid,uuid,uuid,text,uuid),review_visit_cleaner_request(uuid,boolean,text),respond_my_visit_backup(uuid,uuid,uuid,uuid,uuid,boolean,text,uuid) to authenticated;

-- A refused backup stays out of this visit's matching. This is visit-specific,
-- rather than ending the cleaner's relationship with the home permanently.
create table visit_cleaner_exclusions (
  job_id uuid not null references jobs(id),
  cleaner_id uuid not null references cleaners(id),
  primary key(job_id,cleaner_id)
);
alter table visit_cleaner_exclusions enable row level security;
create policy choice_exclusions_read on visit_cleaner_exclusions for select using (
  is_admin() or (current_role_of()='cleaner' and cleaner_id=current_cleaner_id())
  or (current_role_of()='customer' and exists(select 1 from jobs j where j.id=job_id and j.customer_id=current_customer_id())));
revoke all on visit_cleaner_exclusions from public,anon,authenticated;
grant select on visit_cleaner_exclusions to authenticated;
grant all on visit_cleaner_exclusions to service_role;
create table visit_backup_releases (
  assignment_key uuid primary key,
  job_id uuid not null references jobs(id),
  preferred_cleaner_id uuid not null references cleaners(id),
  backup_cleaner_id uuid not null references cleaners(id),
  decision_id uuid not null references visit_backup_decisions(id),
  released_by uuid not null references profiles(id),
  released_at timestamptz not null default now()
);
alter table visit_backup_releases enable row level security;
create policy choice_releases_admin on visit_backup_releases for select using(is_admin());
revoke all on visit_backup_releases from public,anon,authenticated;
grant select on visit_backup_releases to authenticated;
grant all on visit_backup_releases to service_role;

create function release_declined_visit_backup(p_job_id uuid,p_assignment_id uuid,p_preferred_cleaner_id uuid,p_backup_cleaner_id uuid,p_decision_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_decision visit_backup_decisions%rowtype;
begin
  if not is_admin() then raise insufficient_privilege; end if;
  select * into v_job from jobs where id=p_job_id for update;
  if exists(select 1 from visit_backup_releases where assignment_key=p_assignment_id and job_id=p_job_id
    and preferred_cleaner_id=p_preferred_cleaner_id and backup_cleaner_id=p_backup_cleaner_id and decision_id=p_decision_id) then return true; end if;
  if v_job.id is null or v_job.status<>'assigned' or v_job.started_at is not null
    or v_job.preferred_cleaner_id is distinct from p_preferred_cleaner_id
    or (select count(*) from job_assignments where job_id=p_job_id)<>1
    or not exists(select 1 from job_assignments where id=p_assignment_id and job_id=p_job_id and is_lead and cleaner_id=p_backup_cleaner_id) then
    raise exception using errcode='40001',message='Assignment changed before release';
  end if;
  select * into v_decision from visit_backup_decisions where job_id=p_job_id and customer_id=v_job.customer_id and decided_by=(select profile_id from customers where id=v_job.customer_id) and assignment_id=p_assignment_id
    and preferred_cleaner_id=p_preferred_cleaner_id and backup_cleaner_id=p_backup_cleaner_id order by version desc limit 1;
  if v_decision.id is distinct from p_decision_id or v_decision.accepted is distinct from false then
    raise exception using errcode='40001',message='Client has not declined the current backup';
  end if;
  update offers set status='withdrawn',responded_at=now() where job_id=p_job_id and status='sent';
  insert into visit_backup_releases(assignment_key,job_id,preferred_cleaner_id,backup_cleaner_id,decision_id,released_by)
    values(p_assignment_id,p_job_id,p_preferred_cleaner_id,p_backup_cleaner_id,p_decision_id,auth.uid());
  delete from job_assignments where id=p_assignment_id;
  insert into visit_cleaner_exclusions(job_id,cleaner_id) values(p_job_id,p_backup_cleaner_id) on conflict do nothing;
  update jobs set status='scheduled',dispatch_channel=null where id=p_job_id;
  return true;
end $$;
revoke all on function release_declined_visit_backup(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function release_declined_visit_backup(uuid,uuid,uuid,uuid,uuid) to authenticated;

-- Serialize assignment changes with decisions and starts, including writes
-- made through the service role. A declined backup cannot be reassigned.
create function guard_visit_assignment_choice() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from jobs where id=new.job_id for update;
  if exists(select 1 from visit_cleaner_exclusions where job_id=new.job_id and cleaner_id=new.cleaner_id) then
    raise exception using errcode='23514',message='Client declined this cleaner for the visit';
  end if;
  return new;
end $$;
create trigger assignment_choice_guard before insert or update of job_id,cleaner_id,is_lead on job_assignments
for each row execute function guard_visit_assignment_choice();
revoke all on function guard_visit_assignment_choice() from public,anon,authenticated;

create or replace function cleaner_is_eligible(p_cleaner_id uuid, p_job_id uuid)
returns boolean
language sql stable set search_path=public,pg_temp as $$
  select exists (
    select 1
    from cleaners c
    join jobs j on j.id = p_job_id
    join properties p on p.id = j.property_id
    where c.id = p_cleaner_id
      and not exists(select 1 from visit_cleaner_exclusions x where x.job_id=j.id and x.cleaner_id=c.id)
      and c.status = 'active'
      and coalesce(c.rating, 0) >= 3.9                     -- quality floor
      and c.background_check_cleared                        -- never overridable
      and (c.insurance_expires_on is null
           or c.insurance_expires_on > coalesce(j.scheduled_start::date, current_date))
      and (cardinality(c.service_zips) = 0 or p.zip = any (c.service_zips))
      -- not already committed in the window
      and not exists (
        select 1
        from job_assignments ja
        join jobs oj on oj.id = ja.job_id
        where ja.cleaner_id = c.id
          and oj.id <> j.id
          and oj.status in ('scheduled', 'assigned', 'in_progress')
          and j.scheduled_start is not null
          and oj.scheduled_start is not null
          and tstzrange(oj.scheduled_start, coalesce(oj.scheduled_end, oj.scheduled_start))
              && tstzrange(j.scheduled_start, coalesce(j.scheduled_end, j.scheduled_start))
      )
  );
$$;
