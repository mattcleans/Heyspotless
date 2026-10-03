-- A replacement proposal is separate from normal dispatch: teammates already
-- accepted this visit. Private snapshots preserve their exact agreements.
-- Use the PostgreSQL builtin; hosted Supabase keeps uuid-ossp in extensions.
create table spotless_private.crew_lead_proposals (
 id uuid primary key default pg_catalog.gen_random_uuid(),
 job_id uuid not null references public.jobs(id),
 cleaner_id uuid not null references public.cleaners(id),
 created_by uuid not null references public.profiles(id),
 candidate_type public.cleaner_type not null,
 payout_cents integer not null check(payout_cents>=0),
 snapshot jsonb not null,
 candidate_snapshot jsonb not null,
 assignment_key uuid not null default pg_catalog.gen_random_uuid(),
 state text not null default 'review' check(state in ('review','sent','accepted','declined','withdrawn','expired','conflict')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 responded_at timestamptz,
 answer boolean
);
create unique index crew_one_pending on spotless_private.crew_lead_proposals(job_id) where state='sent';
create index on spotless_private.crew_lead_proposals(cleaner_id,created_at desc);
alter table spotless_private.crew_lead_proposals enable row level security;
revoke all on spotless_private.crew_lead_proposals from public,anon,authenticated,service_role;

-- Only this removed cleaner and management may read this notice. Other crew
-- pay and the client's private decision note never appear here.
create table public.crew_lead_releases (
 id uuid primary key references spotless_private.crew_lead_proposals(id),
 job_id uuid not null references public.jobs(id),
 cleaner_id uuid not null references public.cleaners(id),
 previous_start timestamptz,
 new_start timestamptz check(new_start is null),
 released_at timestamptz not null default clock_timestamp()
);
alter table public.crew_lead_releases enable row level security;
create policy crew_release_read on public.crew_lead_releases for select to authenticated using(
 public.is_admin() or (public.current_role_of()='cleaner' and cleaner_id=public.current_cleaner_id()));
revoke all on public.crew_lead_releases from public,anon,authenticated;
grant select on public.crew_lead_releases to authenticated;
grant all on public.crew_lead_releases to service_role;

create function spotless_private.crew_snapshot(p_job uuid) returns jsonb
language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('visit',jsonb_build_object('id',j.id,'customer_id',j.customer_id,
 'customer_profile',(select profile_id from customers where id=j.customer_id),'property_id',j.property_id,
 'property',(select jsonb_build_object('city',city,'zip',zip,'street',street) from properties where id=j.property_id),
 'status',j.status,'started_at',j.started_at,'start',j.scheduled_start,'end',j.scheduled_end,
 'minutes',j.estimated_clean_minutes,'price',j.price_cents,'service',j.service,'freq',j.freq,
 'revision',j.schedule_revision,'preferred',j.preferred_cleaner_id),
 'crew',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from job_assignments a where a.job_id=j.id),
 'decision',(select to_jsonb(d) from visit_backup_decisions d join job_assignments a on a.id=d.assignment_id
 where a.job_id=j.id and a.is_lead and d.customer_id=j.customer_id and d.decided_by=(select profile_id from customers where id=j.customer_id)
 and d.preferred_cleaner_id=j.preferred_cleaner_id and d.backup_cleaner_id=a.cleaner_id order by d.version desc limit 1))
 from jobs j where j.id=p_job
$$;

create function spotless_private.crew_replaceable(p_job uuid) returns boolean
language sql stable set search_path=public,pg_temp as $$
 select exists(select 1 from jobs j where j.id=p_job and j.status='assigned' and j.started_at is null
 and j.scheduled_start is not null and isfinite(j.scheduled_start)
 and (select count(*) from job_assignments a where a.job_id=j.id)>1
 and (select count(*) from job_assignments a where a.job_id=j.id and a.is_lead)=1
 and exists(select 1 from job_assignments a where a.job_id=j.id and a.is_lead and a.cleaner_id<>j.preferred_cleaner_id
 and (select d.accepted from visit_backup_decisions d where d.job_id=j.id and d.assignment_id=a.id
 and d.customer_id=j.customer_id and d.decided_by=(select profile_id from customers where id=j.customer_id)
 and d.preferred_cleaner_id=j.preferred_cleaner_id and d.backup_cleaner_id=a.cleaner_id order by d.version desc limit 1)=false))
$$;

-- Unset weekly availability retains existing dispatch semantics. A declared
-- week must contain this entire Dallas-time visit in one actual window.
create function spotless_private.crew_candidate_eligible(p_job uuid,p_cleaner uuid) returns boolean
language sql stable set search_path=public,pg_temp as $$
 select exists(select 1 from jobs j join properties p on p.id=j.property_id join cleaners c on c.id=p_cleaner
 where j.id=p_job and c.status='active' and c.profile_id is not null
 and exists(select 1 from profiles u where u.id=c.profile_id and u.role='cleaner')
 and coalesce(c.rating,0)>=3.9 and c.background_check_cleared
 and (c.insurance_expires_on is null or c.insurance_expires_on>(j.scheduled_start at time zone 'America/Chicago')::date)
 and (cardinality(c.service_zips)=0 or p.zip=any(c.service_zips))
 and (c.type='contractor_1099' or (c.hourly_rate_cents>0 and c.guaranteed_hours_per_week is not null))
 and not exists(select 1 from job_assignments a where a.job_id=j.id and a.cleaner_id=c.id)
 and not exists(select 1 from visit_cleaner_exclusions x where x.job_id=j.id and x.cleaner_id=c.id)
 and not exists(select 1 from job_assignments a join jobs o on o.id=a.job_id where a.cleaner_id=c.id
 and o.id<>j.id and o.status not in ('complete','canceled')
 and spotless_private.visit_capacity_window(o.scheduled_start,o.scheduled_end,o.estimated_clean_minutes)
 && spotless_private.visit_capacity_window(j.scheduled_start,j.scheduled_end,j.estimated_clean_minutes))
 and (not exists(select 1 from cleaner_availability w where w.cleaner_id=c.id)
 or exists(select 1 from cleaner_availability w where w.cleaner_id=c.id
 and w.day_of_week=extract(dow from j.scheduled_start at time zone 'America/Chicago')
 and ((j.scheduled_start at time zone 'America/Chicago')::date+w.starts_at) at time zone 'America/Chicago' <= j.scheduled_start
 and ((j.scheduled_start at time zone 'America/Chicago')::date+w.ends_at) at time zone 'America/Chicago' >=
 upper(spotless_private.visit_capacity_window(j.scheduled_start,j.scheduled_end,j.estimated_clean_minutes))
 and ((((j.scheduled_start at time zone 'America/Chicago')::date+w.starts_at) at time zone 'America/Chicago') at time zone 'America/Chicago')::time=w.starts_at
 and ((((j.scheduled_start at time zone 'America/Chicago')::date+w.ends_at) at time zone 'America/Chicago') at time zone 'America/Chicago')::time=w.ends_at)))
$$;

create function spotless_private.crew_public_receipt(p_id uuid) returns jsonb
language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',q.id,'jobId',q.job_id,'cleanerName',q.candidate_snapshot->'full_name','type',q.candidate_type,
 'payoutCents',q.payout_cents,'hourlyRateCents',q.candidate_snapshot->'hourly_rate_cents',
 'start',q.snapshot->'visit'->'start','minutes',q.snapshot->'visit'->'minutes',
 'clientPriceCents',q.snapshot->'visit'->'price','expiresAt',q.expires_at,
 'state',case when q.state in ('review','sent') and q.snapshot is distinct from spotless_private.crew_snapshot(q.job_id) then 'withdrawn'
 when q.state in ('review','sent') and q.expires_at<=clock_timestamp() then 'expired' else q.state end,
 'assignmentId',case when q.state='accepted' then q.assignment_key else null end,
 'assignmentCurrent',q.state='accepted' and exists(select 1 from job_assignments a join jobs j on j.id=a.job_id where a.id=q.assignment_key and a.job_id=q.job_id and a.cleaner_id=q.cleaner_id and j.status not in ('complete','canceled')),
 'clientApproved',q.state='accepted' and exists(select 1 from jobs j join job_assignments a on a.job_id=j.id and a.id=q.assignment_key and a.cleaner_id=q.cleaner_id where j.id=q.job_id
 and (j.preferred_cleaner_id is null or j.preferred_cleaner_id=a.cleaner_id or coalesce((select d.accepted from visit_backup_decisions d where d.job_id=j.id and d.assignment_id=a.id and d.customer_id=j.customer_id and d.decided_by=(select profile_id from customers where id=j.customer_id) and d.preferred_cleaner_id=j.preferred_cleaner_id and d.backup_cleaner_id=a.cleaner_id order by d.version desc limit 1),false))),
 'needsClientApproval',q.cleaner_id is distinct from (q.snapshot->'visit'->>'preferred')::uuid,
 'city',q.snapshot->'visit'->'property'->'city')
 from spotless_private.crew_lead_proposals q join cleaners c on c.id=q.cleaner_id
 join properties p on p.id=(q.snapshot->'visit'->>'property_id')::uuid where q.id=p_id
$$;

-- Availability writes outside the editor share its lock too.
create function public.guard_crew_availability() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_id uuid;
begin
 for v_id in select distinct x from unnest(array[case when tg_op<>'INSERT' then old.cleaner_id end,case when tg_op<>'DELETE' then new.cleaner_id end]) x where x is not null order by x loop
 perform pg_advisory_xact_lock(hashtextextended('availability:'||v_id::text,0));
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger crew_availability_serial before insert or update or delete on public.cleaner_availability for each row execute function public.guard_crew_availability();
revoke all on function public.guard_crew_availability() from public,anon,authenticated,service_role;

-- Accepted pay/offer/role edits must serialize with a reviewed replacement,
-- just as assignment inserts, transfers and removals already do.
create function public.guard_crew_assignment_review() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform 1 from public.jobs where id in (old.job_id,new.job_id) order by id for update;
 return new;
end $$;
create trigger assignment_01_crew_review_serial before update on public.job_assignments for each row execute function public.guard_crew_assignment_review();
revoke all on function public.guard_crew_assignment_review() from public,anon,authenticated,service_role;

create function public.read_crew_lead_review(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_snapshot jsonb;
begin
 if not is_admin() or auth.uid() is null then raise insufficient_privilege; end if;
 v_snapshot:=spotless_private.crew_snapshot(p_job_id);
 if v_snapshot is null then raise invalid_parameter_value; end if;
 return jsonb_build_object('canReplace',spotless_private.crew_replaceable(p_job_id),
 'start',v_snapshot->'visit'->'start','clientPriceCents',v_snapshot->'visit'->'price',
 'crew',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',c.full_name,'isLead',a.is_lead,
 'payoutCents',a.payout_cents,'type',c.type) order by a.is_lead desc,a.id),'[]') from job_assignments a join cleaners c on c.id=a.cleaner_id where a.job_id=p_job_id),
 'candidates',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.full_name,'type',c.type) order by c.full_name,c.id),'[]') from cleaners c
 where spotless_private.crew_replaceable(p_job_id) and spotless_private.crew_candidate_eligible(p_job_id,c.id)),
 'proposals',(select coalesce(jsonb_agg(spotless_private.crew_public_receipt(q.id) order by q.created_at desc),'[]') from
 (select * from spotless_private.crew_lead_proposals where job_id=p_job_id order by created_at desc limit 10) q));
end $$;

create function public.quote_crew_lead_replacement(p_job_id uuid,p_cleaner_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_candidate cleaners%rowtype; v_id uuid; v_pay integer;
begin
 if not is_admin() or auth.uid() is null then raise insufficient_privilege; end if;
 select * into v_job from jobs where id=p_job_id for update;
 if not spotless_private.crew_replaceable(p_job_id) then raise exception using errcode='PT409',message='Review the current crew and client decision'; end if;
 perform spotless_private.lock_cleaner_capacity(array[p_cleaner_id]);
 perform pg_advisory_xact_lock(hashtextextended('availability:'||p_cleaner_id::text,0));
 select * into v_candidate from cleaners where id=p_cleaner_id for share;
 perform 1 from properties where id=v_job.property_id for share;
 if not spotless_private.crew_candidate_eligible(p_job_id,p_cleaner_id) then raise exception using errcode='23514',message='Replacement is not eligible'; end if;
 update spotless_private.crew_lead_proposals q set state='withdrawn',responded_at=clock_timestamp()
 where q.job_id=p_job_id and q.state='sent' and (q.expires_at<=clock_timestamp() or q.snapshot is distinct from spotless_private.crew_snapshot(p_job_id));
 if exists(select 1 from spotless_private.crew_lead_proposals where job_id=p_job_id and state='sent') then raise exception using errcode='PT409',message='Resolve the pending replacement first'; end if;
 -- The contractor reviews exactly the outgoing lead's fee. No escalation or
 -- teammate repricing. An employee is paid by existing hourly payroll terms;
 -- the assignment's contractor fee is zero, never copied from another worker.
 select case when v_candidate.type='contractor_1099' then payout_cents else 0 end into v_pay from job_assignments where job_id=p_job_id and is_lead;
 if v_pay<0 or (v_candidate.type='contractor_1099' and v_pay=0) then raise invalid_parameter_value; end if;
 insert into spotless_private.crew_lead_proposals(job_id,cleaner_id,created_by,candidate_type,payout_cents,snapshot,candidate_snapshot)
 values(p_job_id,p_cleaner_id,auth.uid(),v_candidate.type,v_pay,spotless_private.crew_snapshot(p_job_id),to_jsonb(v_candidate)) returning id into v_id;
 return spotless_private.crew_public_receipt(v_id)||jsonb_build_object('reviewCrew',
 (select jsonb_agg(jsonb_build_object('id',a.id,'name',c.full_name,'isLead',a.is_lead,'payoutCents',a.payout_cents,'type',c.type) order by a.is_lead desc,a.id)
 from job_assignments a join cleaners c on c.id=a.cleaner_id where a.job_id=p_job_id));
end $$;

create function spotless_private.apply_crew_lead(p_id uuid) returns void
language plpgsql set search_path=public,pg_temp as $$
declare q spotless_private.crew_lead_proposals%rowtype; a job_assignments%rowtype;
begin
 select * into q from spotless_private.crew_lead_proposals where id=p_id;
 select * into a from job_assignments where job_id=q.job_id and is_lead;
 -- Lock BOTH capacity rows in the same sorted order as assignment triggers.
 perform spotless_private.lock_cleaner_capacity(array[a.cleaner_id,q.cleaner_id]);
 perform pg_advisory_xact_lock(hashtextextended('availability:'||q.cleaner_id::text,0));
 perform 1 from cleaners where id=q.cleaner_id for share;
 perform 1 from properties where id=(q.snapshot->'visit'->>'property_id')::uuid for share;
 if q.snapshot is distinct from spotless_private.crew_snapshot(q.job_id)
 or q.candidate_snapshot is distinct from (select to_jsonb(c) from cleaners c where c.id=q.cleaner_id)
 or not spotless_private.crew_replaceable(q.job_id) or not spotless_private.crew_candidate_eligible(q.job_id,q.cleaner_id) then
 raise exception using errcode='PCP01',message='Replacement details or availability changed'; end if;
 if q.expires_at<=clock_timestamp() then raise exception using errcode='PCR01',message='Replacement expired'; end if;
 update offers set status='withdrawn',responded_at=clock_timestamp() where job_id=q.job_id and (status='sent' or id=a.offer_id);
 insert into crew_lead_releases(id,job_id,cleaner_id,previous_start) values(q.id,q.job_id,a.cleaner_id,(q.snapshot->'visit'->>'start')::timestamptz);
 delete from job_assignments where id=a.id;
 insert into visit_cleaner_exclusions(job_id,cleaner_id) values(q.job_id,a.cleaner_id) on conflict do nothing;
 insert into job_assignments(id,job_id,cleaner_id,is_lead,payout_cents) values(q.assignment_key,q.job_id,q.cleaner_id,true,q.payout_cents);
 update spotless_private.crew_lead_proposals set state='accepted',responded_at=clock_timestamp(),answer=true where id=q.id;
end $$;

create function public.confirm_crew_lead_replacement(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare q spotless_private.crew_lead_proposals%rowtype; v_job uuid;
begin
 if not is_admin() or auth.uid() is null then raise insufficient_privilege; end if;
 select job_id into v_job from spotless_private.crew_lead_proposals where id=p_id and created_by=auth.uid();
 if v_job is null then raise insufficient_privilege; end if;
 perform 1 from jobs where id=v_job for update;
 select * into q from spotless_private.crew_lead_proposals where id=p_id for update;
 if q.state<>'review' then return spotless_private.crew_public_receipt(p_id); end if;
 if q.snapshot is distinct from spotless_private.crew_snapshot(v_job) or not spotless_private.crew_replaceable(v_job)
 or q.expires_at<=clock_timestamp() or q.candidate_snapshot is distinct from (select to_jsonb(c) from cleaners c where c.id=q.cleaner_id) then
 update spotless_private.crew_lead_proposals set state='withdrawn',responded_at=clock_timestamp() where id=p_id;
 return spotless_private.crew_public_receipt(p_id); end if;
 if exists(select 1 from spotless_private.crew_lead_proposals where job_id=v_job and state='sent') then raise exception using errcode='PT409',message='Resolve the pending offer first'; end if;
 if q.candidate_type='contractor_1099' then
 perform spotless_private.lock_cleaner_capacity(array[q.cleaner_id]);
 perform pg_advisory_xact_lock(hashtextextended('availability:'||q.cleaner_id::text,0));
 perform 1 from cleaners where id=q.cleaner_id for share;
 perform 1 from properties where id=(q.snapshot->'visit'->>'property_id')::uuid for share;
 if not spotless_private.crew_candidate_eligible(v_job,q.cleaner_id) or q.candidate_snapshot is distinct from (select to_jsonb(c) from cleaners c where c.id=q.cleaner_id) then
 update spotless_private.crew_lead_proposals set state='conflict',responded_at=clock_timestamp() where id=p_id;
 else update spotless_private.crew_lead_proposals set state='sent',expires_at=clock_timestamp()+interval '30 minutes' where id=p_id; end if;
 else
 begin perform spotless_private.apply_crew_lead(p_id);
 exception when sqlstate 'PCP01' then update spotless_private.crew_lead_proposals set state='conflict',responded_at=clock_timestamp() where id=p_id;
 when sqlstate 'PCR01' then update spotless_private.crew_lead_proposals set state='expired',responded_at=clock_timestamp() where id=p_id;
 end;
 end if;
 return spotless_private.crew_public_receipt(p_id);
end $$;

create function public.withdraw_crew_lead_offer(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job uuid;
begin
 if not is_admin() or auth.uid() is null then raise insufficient_privilege; end if;
 select job_id into v_job from spotless_private.crew_lead_proposals where id=p_id;
 if v_job is null then raise invalid_parameter_value; end if;
 perform 1 from jobs where id=v_job for update;
 update spotless_private.crew_lead_proposals set state='withdrawn',responded_at=clock_timestamp() where id=p_id and state in ('review','sent');
 return spotless_private.crew_public_receipt(p_id);
end $$;

create function public.read_my_crew_lead_offers() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if current_role_of() is distinct from 'cleaner' or current_cleaner_id() is null or auth.uid() is null then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(spotless_private.crew_public_receipt(q.id) order by q.created_at desc),'[]') from
 (select * from spotless_private.crew_lead_proposals where cleaner_id=current_cleaner_id() and state<>'review'
 and created_at>clock_timestamp()-interval '7 days' order by created_at desc limit 20) q);
end $$;

create function public.respond_my_crew_lead_offer(p_id uuid,p_accept boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare q spotless_private.crew_lead_proposals%rowtype; v_job uuid;
begin
 if current_role_of() is distinct from 'cleaner' or current_cleaner_id() is null or auth.uid() is null then raise insufficient_privilege; end if;
 if p_accept is null then raise invalid_parameter_value; end if;
 select job_id into v_job from spotless_private.crew_lead_proposals where id=p_id and cleaner_id=current_cleaner_id() and candidate_type='contractor_1099' and state<>'review';
 if v_job is null then raise insufficient_privilege; end if;
 perform 1 from jobs where id=v_job for update;
 select * into q from spotless_private.crew_lead_proposals where id=p_id for update;
 if q.answer is not null and q.answer is distinct from p_accept then raise exception using errcode='PT409',message='An answer is already saved'; end if;
 if q.state<>'sent' then return spotless_private.crew_public_receipt(p_id); end if;
 if q.snapshot is distinct from spotless_private.crew_snapshot(v_job) then
 update spotless_private.crew_lead_proposals set state='withdrawn',responded_at=clock_timestamp() where id=p_id;
 elsif q.expires_at<=clock_timestamp() then
 update spotless_private.crew_lead_proposals set state='expired',responded_at=clock_timestamp() where id=p_id;
 elsif not p_accept then
 update spotless_private.crew_lead_proposals set state='declined',responded_at=clock_timestamp(),answer=false where id=p_id;
 else
 begin perform spotless_private.apply_crew_lead(p_id);
 exception when sqlstate 'PCP01' then update spotless_private.crew_lead_proposals set state='conflict',responded_at=clock_timestamp() where id=p_id;
 when sqlstate 'PCR01' then update spotless_private.crew_lead_proposals set state='expired',responded_at=clock_timestamp() where id=p_id;
 end;
 end if;
 return spotless_private.crew_public_receipt(p_id);
end $$;

revoke all on all functions in schema spotless_private from public,anon,authenticated,service_role;
revoke all on function public.read_crew_lead_review(uuid),public.quote_crew_lead_replacement(uuid,uuid),public.confirm_crew_lead_replacement(uuid),public.withdraw_crew_lead_offer(uuid),public.read_my_crew_lead_offers(),public.respond_my_crew_lead_offer(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.read_crew_lead_review(uuid),public.quote_crew_lead_replacement(uuid,uuid),public.confirm_crew_lead_replacement(uuid),public.withdraw_crew_lead_offer(uuid),public.read_my_crew_lead_offers(),public.respond_my_crew_lead_offer(uuid,boolean) to authenticated;
