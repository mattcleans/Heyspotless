-- Client-confirmed future recurring edits. New occurrence epochs retain
-- historical/canceled slots while allowing a new cadence to use the same day.
-- Today, started/billed visits and individual exceptions are preserved.
alter table public.recurring_plans add column generation_epoch bigint not null default 1 check(generation_epoch>0);
alter table public.jobs add column generation_epoch bigint not null default 1 check(generation_epoch>0);
drop index public.jobs_one_per_occurrence;
create unique index jobs_one_per_occurrence on public.jobs(recurring_plan_id,generation_epoch,occurrence_date)
 where recurring_plan_id is not null and occurrence_date is not null;

create table public.recurring_schedule_quotes (
 id uuid primary key default uuid_generate_v4(),
 plan_id uuid not null references public.recurring_plans(id),
 customer_id uuid not null references public.customers(id),
 requested_by uuid not null references public.profiles(id),
 effective_from date not null,
 first_date date not null, freq public.frequency not null, start_time time not null,
 paused_until date, ends_on date,
 snapshot jsonb not null, review jsonb not null,
 expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.recurring_schedule_changes (
 id uuid primary key references public.recurring_schedule_quotes(id),
 plan_id uuid not null references public.recurring_plans(id),
 customer_id uuid not null references public.customers(id),
 confirmed_by uuid not null references public.profiles(id),
 generation_epoch bigint not null,
 review jsonb not null,
 confirmed_at timestamptz not null default now(),
 unique(plan_id,generation_epoch)
);
create table public.recurring_schedule_job_changes (
 change_id uuid not null references public.recurring_schedule_changes(id),
 job_id uuid not null references public.jobs(id),
 action text not null check(action in ('moved','removed','added','kept')),
 previous_start timestamptz, new_start timestamptz,
 previous_occurrence date, new_occurrence date,
 previous_epoch bigint, new_epoch bigint,
 previous_price_cents integer, new_price_cents integer,
 reason text not null,
 primary key(change_id,job_id)
);
create table public.recurring_schedule_releases (
 id uuid primary key, change_id uuid not null references public.recurring_schedule_changes(id),
 job_id uuid not null references public.jobs(id), cleaner_id uuid not null references public.cleaners(id),
 offer_id uuid references public.offers(id), payout_cents integer not null,
 is_lead boolean not null, assigned_at timestamptz not null,
 previous_start timestamptz, new_start timestamptz,
 released_at timestamptz not null default now()
);
create index on public.recurring_schedule_changes(plan_id,generation_epoch desc);
create index on public.recurring_schedule_job_changes(job_id);
create index on public.recurring_schedule_releases(cleaner_id,released_at desc);
alter table public.recurring_schedule_quotes enable row level security;
alter table public.recurring_schedule_changes enable row level security;
alter table public.recurring_schedule_job_changes enable row level security;
alter table public.recurring_schedule_releases enable row level security;
create policy recurring_changes_read on public.recurring_schedule_changes for select to authenticated
 using(is_admin() or (current_role_of()='customer' and exists(select 1 from public.recurring_plans p where p.id=plan_id and p.customer_id=current_customer_id())));
create policy recurring_job_changes_read on public.recurring_schedule_job_changes for select to authenticated
 using(exists(select 1 from public.recurring_schedule_changes r where r.id=change_id));
create policy recurring_releases_read on public.recurring_schedule_releases for select to authenticated
 using(is_admin() or (current_role_of()='cleaner' and cleaner_id=current_cleaner_id()));
revoke all on public.recurring_schedule_quotes,public.recurring_schedule_changes,public.recurring_schedule_job_changes,public.recurring_schedule_releases from public,anon,authenticated;
grant select on public.recurring_schedule_changes,public.recurring_schedule_job_changes,public.recurring_schedule_releases to authenticated;
grant all on public.recurring_schedule_quotes,public.recurring_schedule_changes,public.recurring_schedule_job_changes,public.recurring_schedule_releases to service_role;

create or replace function public.bump_recurring_schedule_revision()
returns trigger language plpgsql set search_path = public as $$
begin
  if row(new.customer_id,new.property_id,new.service,new.freq,new.anchor_date,
         new.start_time,new.ends_on,new.paused_until,new.active,new.horizon_days,
         new.agreed_price_cents,new.estimated_minutes,new.notes,
         new.preferred_cleaner_id,new.agreed_payout_share,new.generation_epoch)
     is distinct from
     row(old.customer_id,old.property_id,old.service,old.freq,old.anchor_date,
         old.start_time,old.ends_on,old.paused_until,old.active,old.horizon_days,
         old.agreed_price_cents,old.estimated_minutes,old.notes,
         old.preferred_cleaner_id,old.agreed_payout_share,old.generation_epoch) then
    new.schedule_revision := old.schedule_revision + 1;
  else
    new.schedule_revision := old.schedule_revision;
  end if;
  if new.generation_epoch is distinct from old.generation_epoch then
    new.generation_epoch := old.generation_epoch+1;
  end if;
  return new;
end $$;
revoke all on function public.bump_recurring_schedule_revision() from public,anon,authenticated;
create or replace function public.materialise_recurring_job(
  p_plan_id uuid,p_occurrence_date date,p_scheduled_start timestamptz
) returns table(job_id uuid,created boolean)
language plpgsql security definer set search_path = public as $$
declare v_plan public.recurring_plans%rowtype; v_job_id uuid; v_start timestamptz;
begin
  select * into v_plan from public.recurring_plans where id=p_plan_id for update;
  if v_plan.id is null then raise exception 'recurring plan not found' using errcode='22023'; end if;
  if not v_plan.active then raise exception 'recurring plan is not active' using errcode='40001'; end if;
  if p_occurrence_date is null or not isfinite(p_occurrence_date) then
    raise exception 'invalid occurrence date' using errcode='22023';
  end if;
  if exists(select 1 from public.recurring_plan_skips
            where plan_id=p_plan_id and occurrence_date=p_occurrence_date) then
    return query select null::uuid,false; return;
  end if;
  select j.id into v_job_id from public.jobs j
    where j.recurring_plan_id=p_plan_id and j.generation_epoch=v_plan.generation_epoch and j.occurrence_date=p_occurrence_date;
  if v_job_id is not null then return query select v_job_id,false; return; end if;
  if not public.recurring_date_matches(v_plan.freq,v_plan.anchor_date,p_occurrence_date)
     or (v_plan.ends_on is not null and p_occurrence_date > v_plan.ends_on)
     or (v_plan.paused_until is not null and p_occurrence_date <= v_plan.paused_until) then
    return query select null::uuid,false; return;
  end if;
  -- A retained exception can fill a later-generated slot on its actual day.
  -- Re-key only its occurrence identity; preserve time, price and assignment.
  select j.id into v_job_id from public.jobs j
   where j.recurring_plan_id=p_plan_id and j.generation_epoch<v_plan.generation_epoch
    and j.status<>'canceled' and (j.scheduled_start at time zone 'America/Chicago')::date=p_occurrence_date
    and exists(select 1 from public.recurring_schedule_job_changes a
      join public.recurring_schedule_changes r on r.id=a.change_id
      where a.job_id=j.id and a.action='kept' and r.plan_id=p_plan_id
       and r.generation_epoch=v_plan.generation_epoch)
   order by j.scheduled_start,j.id limit 1 for update;
  if v_job_id is not null then
   update public.jobs set generation_epoch=v_plan.generation_epoch,occurrence_date=p_occurrence_date where id=v_job_id;
   return query select v_job_id,false; return;
  end if;
  v_start := public.recurring_start_at(p_occurrence_date,v_plan.start_time);
  insert into public.jobs(
    customer_id,property_id,recurring_plan_id,occurrence_date,status,service,freq,
    scheduled_start,price_cents,estimated_clean_minutes,notes,preferred_cleaner_id,agreed_payout_share,generation_epoch
  ) values (
    v_plan.customer_id,v_plan.property_id,p_plan_id,p_occurrence_date,'scheduled',v_plan.service,v_plan.freq,
    v_start,v_plan.agreed_price_cents,v_plan.estimated_minutes,v_plan.notes,
    v_plan.preferred_cleaner_id,v_plan.agreed_payout_share,v_plan.generation_epoch
  ) on conflict (recurring_plan_id,generation_epoch,occurrence_date)
      where recurring_plan_id is not null and occurrence_date is not null
    do nothing returning id into v_job_id;
  if v_job_id is null then
    select j.id into v_job_id from public.jobs j
      where j.recurring_plan_id=p_plan_id and j.generation_epoch=v_plan.generation_epoch and j.occurrence_date=p_occurrence_date;
    return query select v_job_id,false; return;
  end if;
  update public.recurring_plans set last_generated_at=now(),
    next_job_date=least(coalesce(next_job_date,p_occurrence_date),p_occurrence_date)
    where id=p_plan_id;
  return query select v_job_id,true;
end $$;
revoke all on function public.materialise_recurring_job(uuid,date,timestamptz) from public,anon,authenticated;
grant execute on function public.materialise_recurring_job(uuid,date,timestamptz) to service_role;


-- Every actor uses plan -> jobs -> invoices. This also serialises generation,
-- offer acceptance, starts and collection while a review is confirmed.
create function public.lock_recurring_edit(p_plan uuid,p_from date) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from recurring_plans where id=p_plan for update;
 perform 1 from jobs where recurring_plan_id=p_plan and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from)
  order by id for update;
 perform 1 from invoices where job_id in (select id from jobs where recurring_plan_id=p_plan)
  order by id for update;
end $$;
create function public.recurring_edit_snapshot(p_plan uuid,p_from date) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'plan',to_jsonb(p)-'last_generated_at'-'next_job_date',
  'property',jsonb_build_object('id',h.id,'customer_id',h.customer_id,'bedrooms',h.bedrooms,
    'bathrooms',h.bathrooms,'half_baths',h.half_baths,'kitchens',h.kitchens,'living_rooms',h.living_rooms,'utility_rooms',h.utility_rooms),
  'skips',coalesce((select jsonb_agg(to_jsonb(s) order by s.occurrence_date) from recurring_plan_skips s where s.plan_id=p.id),'[]'::jsonb),
  'jobs',coalesce((select jsonb_agg(jsonb_build_object('job',to_jsonb(j),'assignments',visit_assignment_snapshot(j.id),
    'offers',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from offers o where o.job_id=j.id),'[]'::jsonb),
    'invoices',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from invoices i where i.job_id=j.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(op) order by op.id) from payment_operations op join invoices i on i.id=op.invoice_id where i.job_id=j.id),'[]'::jsonb),
    'photos',coalesce((select jsonb_agg(to_jsonb(ph) order by ph.id) from job_photos ph where ph.job_id=j.id),'[]'::jsonb),
    'entries',coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from time_entries t where t.job_id=j.id),'[]'::jsonb)
   ) order by j.id) from jobs j where j.recurring_plan_id=p.id and j.status<>'canceled'
    and (j.occurrence_date>=p_from or (j.scheduled_start at time zone 'America/Chicago')::date>=p_from)),'[]'::jsonb))
 from recurring_plans p join properties h on h.id=p.property_id where p.id=p_plan
$$;

-- Pure review of the locked schedule. Private helper: never returns assignments
-- or agreed cleaner pay, only dates, client prices and release counts.
create function public.preview_recurring_edit(p_plan uuid,p_first date,p_freq public.frequency,p_time time,p_pause date,p_end date,p_from date)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p recurring_plans%rowtype; h properties%rowtype; j jobs%rowtype;
 v_price integer; v_minutes integer; v_dates date[]:='{}'; v_used date[]:='{}';
 v_date date; v_slot date; v_start timestamptz; v_reason text; v_action text;
 v_visits jsonb:='[]'; v_protected boolean; v_distance integer; v_release integer;
 v_changed boolean;
begin
 select * into p from recurring_plans where id=p_plan;
 select * into h from properties where id=p.property_id;
 if p.id is null or h.id is null or h.customer_id is distinct from p.customer_id or not p.active then
  raise exception 'schedule unavailable' using errcode='40001';
 end if;
 if exists(select 1 from jobs where recurring_plan_id=p.id and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from)
  and (customer_id is distinct from p.customer_id or property_id is distinct from p.property_id or service is distinct from p.service)) then
  raise exception 'schedule ownership needs office review' using errcode='40001';
 end if;
 if p_from is null or p_from<>(clock_timestamp() at time zone 'America/Chicago')::date+1
  or p_first is null or not isfinite(p_first) or p_first<p_from or p_first>p_from+366
  or p_freq is null or p_freq not in ('weekly','biweekly','monthly') or p_time is null
  or extract(second from p_time)<>0 or p_time>=time '24:00'
  or (p_pause is not null and (not isfinite(p_pause) or p_pause>p_first+366))
  or (p_end is not null and (not isfinite(p_end) or p_end<p_first or p_end>p_first+3660)) then
  raise exception 'choose a valid future date, frequency and time' using errcode='22023';
 end if;
 if (select count(*) from jobs where recurring_plan_id=p.id and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from))>500 then
  raise exception 'this schedule needs office review' using errcode='40001';
 end if;
 v_price:=p.agreed_price_cents; v_minutes:=p.estimated_minutes;
 if p_freq<>p.freq then
  if not exists(select 1 from price_book_items i join price_book_rates r on r.item_id=i.id where i.active and i.service=p.service and r.freq=p_freq) then
   raise exception 'frequency unavailable for this service' using errcode='22023';
  end if;
  select q.total_cents,q.clean_minutes into v_price,v_minutes from quote_price(p.service,p_freq,
   h.bedrooms,h.bathrooms,h.half_baths,h.kitchens,h.living_rooms,h.utility_rooms) q;
 end if;
 if v_price is null or v_price<0 or v_minutes is null or v_minutes<=0 then
  raise exception 'a current service price is required' using errcode='40001';
 end if;
 for v_date in select d::date from generate_series(p_first::timestamp,(p_first+p.horizon_days)::timestamp,interval '1 day') d loop
  if recurring_date_matches(p_freq,p_first,v_date) and (p_end is null or v_date<=p_end)
   and (p_pause is null or v_date>p_pause)
   and not exists(select 1 from recurring_plan_skips where plan_id=p.id and occurrence_date=v_date) then
   v_dates:=array_append(v_dates,v_date);
  end if;
 end loop;
 v_distance:=case p_freq when 'weekly' then 3 when 'biweekly' then 7 else 16 end;
 -- Protected exceptions claim their nearby new slot first. Their actual terms
 -- stay untouched; the review explains which new occurrence they replace.
 for j in select * from jobs where recurring_plan_id=p.id and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from)
  order by case when (scheduled_start at time zone 'America/Chicago')::date=any(v_dates) then 0 else 1 end,scheduled_start nulls last,id loop
  v_protected:=j.started_at is not null or j.status not in ('unscheduled','scheduled','dispatching','assigned')
   or j.scheduled_start is null or (j.scheduled_start at time zone 'America/Chicago')::date<p_from
   or j.generation_epoch<>p.generation_epoch or j.occurrence_date is null
   or not recurring_date_matches(p.freq,p.anchor_date,j.occurrence_date)
   or j.scheduled_start is distinct from case when j.occurrence_date is null then null else recurring_start_at(j.occurrence_date,p.start_time) end
   or j.price_cents is distinct from p.agreed_price_cents or j.estimated_clean_minutes is distinct from p.estimated_minutes
   or j.invoiced_at is not null or exists(select 1 from invoices where job_id=j.id)
   or exists(select 1 from time_entries where job_id=j.id) or exists(select 1 from job_photos where job_id=j.id);
  if not v_protected then continue; end if;
  v_reason:=case when j.started_at is not null or j.status not in ('unscheduled','scheduled','dispatching','assigned')
    or exists(select 1 from time_entries where job_id=j.id) or exists(select 1 from job_photos where job_id=j.id) then 'Work already started or recorded'
   when j.scheduled_start is null or (j.scheduled_start at time zone 'America/Chicago')::date<p_from then 'Today’s visit stays as booked'
   when j.invoiced_at is not null or exists(select 1 from invoices where job_id=j.id) then 'Existing billing stays unchanged'
   else 'Individual appointment or agreed terms stay unchanged' end;
  v_slot:=null;
  select d into v_slot from unnest(v_dates) d where not (d=any(v_used))
   and (j.scheduled_start at time zone 'America/Chicago')::date>=p_from
   and abs(d-(j.scheduled_start at time zone 'America/Chicago')::date)<=v_distance
   order by abs(d-(j.scheduled_start at time zone 'America/Chicago')::date),d limit 1;
  if v_slot is not null then v_used:=array_append(v_used,v_slot); end if;
  v_visits:=v_visits||jsonb_build_array(jsonb_build_object('job_id',j.id,'action','kept','previous_start',j.scheduled_start,
   'new_start',j.scheduled_start,'previous_occurrence',j.occurrence_date,'new_occurrence',coalesce(v_slot,j.occurrence_date),
   'previous_epoch',j.generation_epoch,'new_epoch',case when v_slot is null then j.generation_epoch else p.generation_epoch+1 end,
   'previous_price_cents',j.price_cents,'new_price_cents',j.price_cents,'reason',v_reason,'released_count',0,'fills_date',v_slot));
 end loop;
 for j in select * from jobs where recurring_plan_id=p.id and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from)
  and not exists(select 1 from jsonb_array_elements(v_visits) a where a->>'job_id'=jobs.id::text)
  order by scheduled_start,id loop
  v_slot:=null;
  select d into v_slot from unnest(v_dates) d where not (d=any(v_used)) order by d limit 1;
  if v_slot is null then
   v_start:=null; v_action:='removed'; v_reason:='Outside the new pattern';
  else
   v_used:=array_append(v_used,v_slot); v_start:=recurring_start_at(v_slot,p_time);
   v_changed:=row(j.scheduled_start,coalesce(j.scheduled_end,j.scheduled_start+make_interval(mins=>j.estimated_clean_minutes)),j.freq,j.price_cents,j.estimated_clean_minutes)
    is distinct from row(v_start,v_start+make_interval(mins=>v_minutes),p_freq,v_price,v_minutes);
   v_action:=case when v_changed then 'moved' else 'kept' end;
   v_reason:=case when v_changed then 'Updated to the new pattern' else 'Already matches the new pattern' end;
  end if;
  v_release:=case when v_action='kept' then 0 else (select count(*) from job_assignments where job_id=j.id) end;
  v_visits:=v_visits||jsonb_build_array(jsonb_build_object('job_id',j.id,'action',v_action,'previous_start',j.scheduled_start,
   'new_start',v_start,'previous_occurrence',j.occurrence_date,'new_occurrence',coalesce(v_slot,j.occurrence_date),
   'previous_epoch',j.generation_epoch,'new_epoch',case when v_slot is null then j.generation_epoch else p.generation_epoch+1 end,
   'previous_price_cents',j.price_cents,'new_price_cents',case when v_slot is null then null else v_price end,
   'reason',v_reason,'released_count',v_release,'fills_date',v_slot));
 end loop;
 foreach v_slot in array v_dates loop
  if v_slot=any(v_used) then continue; end if;
  v_visits:=v_visits||jsonb_build_array(jsonb_build_object('job_id',null,'action','added','previous_start',null,
   'new_start',recurring_start_at(v_slot,p_time),'previous_occurrence',null,'new_occurrence',v_slot,
   'previous_epoch',null,'new_epoch',p.generation_epoch+1,'previous_price_cents',null,'new_price_cents',v_price,
   'reason','New appointment in the pattern','released_count',0,'fills_date',v_slot));
 end loop;
 return jsonb_build_object('plan_id',p.id,'effective_from',p_from,'first_date',p_first,'freq',p_freq,'start_time',p_time,
  'paused_until',p_pause,'ends_on',p_end,'price_cents',v_price,'previous_price_cents',p.agreed_price_cents,
  'estimated_minutes',v_minutes,'fee_cents',0,'horizon_until',p_first+p.horizon_days,'visits',v_visits,
  'preserved_skips',coalesce((select jsonb_agg(occurrence_date order by occurrence_date) from recurring_plan_skips where plan_id=p.id and occurrence_date>=p_from),'[]'::jsonb));
end $$;

create function public.quote_my_recurring_schedule(p_plan uuid,p_first date,p_freq public.frequency,p_time time,p_pause date default null,p_end date default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p recurring_plans%rowtype; q recurring_schedule_quotes%rowtype; v_from date; v_review jsonb;
begin
 if auth.uid() is null or not (is_admin() or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 select * into p from recurring_plans where id=p_plan and (is_admin() or customer_id=current_customer_id()) for update;
 if p.id is null then raise exception 'schedule unavailable' using errcode='42501'; end if;
 perform 1 from properties where id=p.property_id for share;
 v_from:=(clock_timestamp() at time zone 'America/Chicago')::date+1;
 perform lock_recurring_edit(p.id,v_from);
 v_review:=preview_recurring_edit(p.id,p_first,p_freq,p_time,p_pause,p_end,v_from);
 insert into recurring_schedule_quotes(plan_id,customer_id,requested_by,effective_from,first_date,freq,start_time,paused_until,ends_on,snapshot,review,expires_at)
 values(p.id,p.customer_id,auth.uid(),v_from,p_first,p_freq,p_time,p_pause,p_end,recurring_edit_snapshot(p.id,v_from),v_review,clock_timestamp()+interval '5 minutes') returning * into q;
 return jsonb_build_object('id',q.id,'review',q.review,'expires_at',q.expires_at);
end $$;

create function public.confirm_my_recurring_schedule(p_plan uuid,p_quote uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p recurring_plans%rowtype; q recurring_schedule_quotes%rowtype; r recurring_schedule_changes%rowtype;
 a jsonb; v_visits jsonb:='[]'; v_review jsonb; v_job uuid; v_created boolean;
begin
 if auth.uid() is null or not (is_admin() or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 select * into p from recurring_plans where id=p_plan and (is_admin() or customer_id=current_customer_id()) for update;
 if p.id is null then raise exception 'schedule unavailable' using errcode='42501'; end if;
 select * into q from recurring_schedule_quotes where id=p_quote and plan_id=p.id and customer_id=p.customer_id and requested_by=auth.uid();
 if q.id is null then raise exception 'review this schedule' using errcode='42501'; end if;
 select * into r from recurring_schedule_changes where id=q.id;
 if r.id is not null then return jsonb_build_object('id',r.id,'review',r.review,'confirmed_at',r.confirmed_at); end if;
 if q.expires_at<=clock_timestamp() or q.effective_from<>(clock_timestamp() at time zone 'America/Chicago')::date+1 then
  raise exception 'schedule review expired; review again' using errcode='40001';
 end if;
 perform 1 from properties where id=p.property_id for share;
 perform lock_recurring_edit(p.id,q.effective_from);
 if q.snapshot is distinct from recurring_edit_snapshot(p.id,q.effective_from)
  or q.review is distinct from preview_recurring_edit(p.id,q.first_date,q.freq,q.start_time,q.paused_until,q.ends_on,q.effective_from) then
  raise exception 'schedule or price changed; review again' using errcode='40001';
 end if;
 update recurring_plans set freq=q.freq,anchor_date=q.first_date,start_time=q.start_time,paused_until=q.paused_until,
  paused_reason=case when q.paused_until is null then null else 'Client-confirmed schedule' end,ends_on=q.ends_on,
  agreed_price_cents=(q.review->>'price_cents')::integer,estimated_minutes=(q.review->>'estimated_minutes')::integer,
  generation_epoch=generation_epoch+1 where id=p.id returning * into p;
 insert into recurring_schedule_changes(id,plan_id,customer_id,confirmed_by,generation_epoch,review)
 values(q.id,p.id,p.customer_id,auth.uid(),p.generation_epoch,q.review) returning * into r;
 -- Retained slots are claimed before generation. Generation never resurrects a
 -- canceled old occurrence or duplicates an individual exception in this review.
 for a in select value from jsonb_array_elements(q.review->'visits') where value->>'action'<>'added' loop
  v_job:=(a->>'job_id')::uuid;
  if a->>'action' in ('moved','removed') then
   insert into recurring_schedule_releases(id,change_id,job_id,cleaner_id,offer_id,payout_cents,is_lead,assigned_at,previous_start,new_start)
   select x.id,r.id,v_job,x.cleaner_id,x.offer_id,x.payout_cents,x.is_lead,x.assigned_at,
    (a->>'previous_start')::timestamptz,(a->>'new_start')::timestamptz from job_assignments x where x.job_id=v_job;
   update offers set status='withdrawn',responded_at=clock_timestamp() where job_id=v_job and status in ('sent','accepted');
   delete from job_assignments where job_id=v_job;
   if a->>'action'='removed' then
    update jobs set status='canceled',dispatch_channel=null where id=v_job;
    update visit_cleaner_requests set status='withdrawn' where job_id=v_job and status='pending';
   else
    update jobs set scheduled_start=(a->>'new_start')::timestamptz,
     scheduled_end=(a->>'new_start')::timestamptz+make_interval(mins=>(q.review->>'estimated_minutes')::integer),
     price_cents=(a->>'new_price_cents')::integer,estimated_clean_minutes=(q.review->>'estimated_minutes')::integer,
     freq=q.freq,status='scheduled',dispatch_channel=null,generation_epoch=p.generation_epoch,
     occurrence_date=(a->>'new_occurrence')::date where id=v_job;
   end if;
  elsif (a->>'new_epoch')::bigint=p.generation_epoch then
   update jobs set generation_epoch=p.generation_epoch,occurrence_date=(a->>'new_occurrence')::date where id=v_job;
  end if;
  insert into recurring_schedule_job_changes(change_id,job_id,action,previous_start,new_start,previous_occurrence,new_occurrence,previous_epoch,new_epoch,previous_price_cents,new_price_cents,reason)
  values(r.id,v_job,a->>'action',(a->>'previous_start')::timestamptz,(a->>'new_start')::timestamptz,
   (a->>'previous_occurrence')::date,(a->>'new_occurrence')::date,(a->>'previous_epoch')::bigint,(a->>'new_epoch')::bigint,
   (a->>'previous_price_cents')::integer,(a->>'new_price_cents')::integer,a->>'reason');
  v_visits:=v_visits||jsonb_build_array(a);
 end loop;
 for a in select value from jsonb_array_elements(q.review->'visits') where value->>'action'='added' loop
  select m.job_id,m.created into v_job,v_created from materialise_recurring_job(p.id,(a->>'new_occurrence')::date,(a->>'new_start')::timestamptz) m;
  if v_job is null or not v_created then raise exception 'schedule changed during confirmation' using errcode='40001'; end if;
  a:=a||jsonb_build_object('job_id',v_job);
  insert into recurring_schedule_job_changes(change_id,job_id,action,new_start,new_occurrence,new_epoch,new_price_cents,reason)
  values(r.id,v_job,'added',(a->>'new_start')::timestamptz,(a->>'new_occurrence')::date,p.generation_epoch,(a->>'new_price_cents')::integer,a->>'reason');
  v_visits:=v_visits||jsonb_build_array(a);
 end loop;
 v_review:=jsonb_set(q.review,'{visits}',v_visits);
 update recurring_schedule_changes set review=v_review where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'review',r.review,'confirmed_at',r.confirmed_at);
end $$;

create function public.guard_recurring_removed_visit() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.status='canceled' and new.status<>'canceled' and exists(select 1 from recurring_schedule_job_changes where job_id=old.id and action='removed') then
  raise exception 'a removed recurring visit cannot be reopened' using errcode='23514';
 end if;
 return new;
end $$;
create trigger jobs_recurring_removed_guard before update on jobs for each row execute function guard_recurring_removed_visit();
revoke all on function public.lock_recurring_edit(uuid,date),public.recurring_edit_snapshot(uuid,date),
 public.preview_recurring_edit(uuid,date,public.frequency,time,date,date,date),public.guard_recurring_removed_visit()
 from public,anon,authenticated;
revoke all on function public.quote_my_recurring_schedule(uuid,date,public.frequency,time,date,date),public.confirm_my_recurring_schedule(uuid,uuid) from public,anon;
grant execute on function public.quote_my_recurring_schedule(uuid,date,public.frequency,time,date,date),public.confirm_my_recurring_schedule(uuid,uuid) to authenticated;

-- Metadata-only slot reassignment invalidates an individual review without
-- changing the terms accepted by a cleaner on a retained appointment.
alter table public.visit_cancellation_quotes add column generation_epoch bigint not null default 1;
alter table public.visit_reschedule_quotes add column generation_epoch bigint not null default 1;
create or replace function public.stamp_cancellation_schedule() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='visit_cancellation_quotes' then
  select schedule_revision,generation_epoch into new.schedule_revision,new.generation_epoch from jobs where id=new.job_id;
 else
  if (select row(q.schedule_revision,q.generation_epoch) from visit_cancellation_quotes q where q.id=new.id)
     is distinct from (select row(j.schedule_revision,j.generation_epoch) from jobs j where j.id=new.job_id) then
   raise exception 'appointment changed since cancellation review' using errcode='40001';
  end if;
 end if;
 return new;
end $$;
create function public.stamp_reschedule_epoch() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='visit_reschedule_quotes' then
  select generation_epoch into new.generation_epoch from jobs where id=new.job_id;
 elsif (select q.generation_epoch from visit_reschedule_quotes q where q.id=new.id)
    is distinct from (select j.generation_epoch from jobs j where j.id=new.job_id) then
  raise exception 'appointment changed since reschedule review' using errcode='40001';
 end if;
 return new;
end $$;
create trigger reschedule_quote_epoch before insert on public.visit_reschedule_quotes for each row execute function public.stamp_reschedule_epoch();
create trigger reschedule_receipt_epoch before insert on public.visit_reschedules for each row execute function public.stamp_reschedule_epoch();
revoke all on function public.stamp_reschedule_epoch() from public,anon,authenticated;

create or replace function quote_my_visit_cancellation(p_job_id uuid,p_reason text)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_quote visit_cancellation_quotes%rowtype; v_admin boolean;
begin
 v_admin:=is_admin();
 if auth.uid() is null or not (v_admin or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 if p_reason not in ('cancel','skip','door_turnaway') or p_reason is null or (p_reason='door_turnaway' and not v_admin) then
  raise exception 'invalid cancellation reason' using errcode='22023';
 end if;
 select * into v_job from jobs where id=p_job_id for update;
 if v_job.id is null or (not v_admin and v_job.customer_id is distinct from current_customer_id()) then
  raise exception 'visit unavailable' using errcode='42501';
 end if;
 if v_job.status not in ('unscheduled','scheduled','dispatching','assigned') or v_job.started_at is not null then
  raise exception 'visit is already started or closed' using errcode='40001';
 end if;
 if p_reason='skip' and (v_job.recurring_plan_id is null or v_job.occurrence_date is null or v_job.generation_epoch is distinct from (select generation_epoch from recurring_plans where id=v_job.recurring_plan_id and customer_id=v_job.customer_id)) then
  raise exception 'only a recurring visit can be skipped' using errcode='22023';
 end if;
 if not v_admin and v_job.scheduled_start is not null and
 (v_job.scheduled_start at time zone 'America/Chicago')::date < (clock_timestamp() at time zone 'America/Chicago')::date then
  raise exception 'past visit needs office review' using errcode='40001';
 end if;
 insert into visit_cancellation_quotes(job_id,customer_id,requested_by,reason,scheduled_start,fee_cents,expires_at,recurring_plan_id,occurrence_date)
 values(v_job.id,v_job.customer_id,auth.uid(),p_reason,v_job.scheduled_start,
 visit_cancellation_fee(v_job.scheduled_start,p_reason,clock_timestamp()),clock_timestamp()+interval '5 minutes',v_job.recurring_plan_id,v_job.occurrence_date)
 returning * into v_quote;
 return to_jsonb(v_quote);
end $$;

create or replace function confirm_my_visit_cancellation(p_job_id uuid,p_quote_id uuid)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_quote visit_cancellation_quotes%rowtype;
 v_saved visit_cancellations%rowtype; v_invoice invoices%rowtype; v_review boolean:=false;
 v_fee_invoice uuid; v_admin boolean; v_plan uuid;
begin
 v_admin:=is_admin();
 if auth.uid() is null or not (v_admin or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 -- Generator and skips lock the plan before the job. Use the same order.
 select recurring_plan_id into v_plan from jobs where id=p_job_id and (v_admin or customer_id=current_customer_id());
 if not found then raise exception 'visit unavailable' using errcode='42501'; end if;
 if v_plan is not null then perform 1 from recurring_plans where id=v_plan for update; end if;
 select * into v_job from jobs where id=p_job_id for update;
 if v_job.id is null or (not v_admin and v_job.customer_id is distinct from current_customer_id()) then
  raise exception 'visit unavailable' using errcode='42501';
 end if;
 select * into v_quote from visit_cancellation_quotes where id=p_quote_id;
 if v_quote.id is null or v_quote.job_id<>p_job_id or v_quote.requested_by<>auth.uid()
 or v_quote.customer_id<>v_job.customer_id then
  raise exception 'review this visit cancellation' using errcode='42501';
 end if;
 select * into v_saved from visit_cancellations where id=p_quote_id;
 if v_saved.id is not null then return to_jsonb(v_saved); end if;
 if v_job.status not in ('unscheduled','scheduled','dispatching','assigned') or v_job.started_at is not null
 or v_quote.scheduled_start is distinct from v_job.scheduled_start or v_quote.expires_at<=clock_timestamp()
 or v_job.recurring_plan_id is distinct from v_plan or v_quote.recurring_plan_id is distinct from v_job.recurring_plan_id
 or v_quote.occurrence_date is distinct from v_job.occurrence_date
 or v_quote.fee_cents<>visit_cancellation_fee(v_job.scheduled_start,v_quote.reason,clock_timestamp()) then
  raise exception 'visit or fee changed; review again' using errcode='40001';
 end if;
 if v_quote.reason='door_turnaway' and not v_admin then raise exception 'office required' using errcode='42501'; end if;
 if v_job.recurring_plan_id is not null and v_job.occurrence_date is not null and v_job.generation_epoch=(select generation_epoch from recurring_plans where id=v_job.recurring_plan_id and customer_id=v_job.customer_id) then
  insert into recurring_plan_skips(plan_id,occurrence_date,reason,created_by)
  values(v_job.recurring_plan_id,v_job.occurrence_date,'Client-confirmed '||v_quote.reason,auth.uid())
  on conflict(plan_id,occurrence_date) do nothing;
 end if;
 -- An inactive cleaner must not prevent withdrawing old offers.
 update offers set status='withdrawn',responded_at=clock_timestamp() where job_id=p_job_id and status='sent';
 update jobs set status='canceled',dispatch_channel=null where id=p_job_id;
 update visit_cleaner_requests set status='withdrawn' where job_id=p_job_id and status='pending';
 -- Serialise with collection. Existing/uncertain provider payments need office
 -- reconciliation; cancel the appointment now without inventing a refund.
 for v_invoice in select * from invoices where job_id=p_job_id order by id for update loop
  if v_invoice.amount_paid_cents>0 or v_invoice.refunded_cents>0 or v_invoice.stripe_checkout_session_id is not null
  or exists(select 1 from payment_operations where invoice_id=v_invoice.id and (state='open' or stripe_object_id is not null)) then
   v_review:=true;
   update invoices set autocharge_paused_at=coalesce(autocharge_paused_at,clock_timestamp()),
    autocharge_paused_reason='Canceled visit: reconcile existing payment before collecting',next_attempt_at=null where id=v_invoice.id;
  elsif v_invoice.voided_at is null then
   update invoices set status='void',voided_at=clock_timestamp(),next_attempt_at=null where id=v_invoice.id;
  end if;
 end loop;
 if v_quote.fee_cents>0 and not v_review then
  insert into invoices(job_id,customer_id,status,subtotal_cents,total_cents,due_on,issued_at)
  values(p_job_id,v_job.customer_id,'sent',v_quote.fee_cents,v_quote.fee_cents,
   (clock_timestamp() at time zone 'America/Chicago')::date,clock_timestamp()) returning id into v_fee_invoice;
 end if;
 insert into visit_cancellations(id,job_id,customer_id,confirmed_by,reason,scheduled_start,fee_cents,invoice_id,billing_review)
 values(v_quote.id,p_job_id,v_job.customer_id,auth.uid(),v_quote.reason,v_job.scheduled_start,v_quote.fee_cents,v_fee_invoice,v_review)
 returning * into v_saved;
 return to_jsonb(v_saved);
end $$;

create or replace function public.skip_recurring_occurrence(p_plan_id uuid,p_occurrence_date date,p_reason text default null,p_created_by uuid default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p recurring_plans%rowtype; j jobs%rowtype;
begin
 select * into p from recurring_plans where id=p_plan_id for update;
 if p.id is null then raise exception 'schedule unavailable' using errcode='22023'; end if;
 select * into j from jobs where recurring_plan_id=p.id and generation_epoch=p.generation_epoch and occurrence_date=p_occurrence_date for update;
 if j.started_at is not null or j.status in ('complete','in_progress') then
  raise exception 'cannot skip started or completed work' using errcode='40001';
 end if;
 insert into recurring_plan_skips(plan_id,occurrence_date,reason,created_by) values(p.id,p_occurrence_date,p_reason,p_created_by)
  on conflict(plan_id,occurrence_date) do nothing;
 update jobs set status='canceled' where id=j.id;
 return true;
end $$;
create or replace function public.unskip_recurring_occurrence(p_plan_id uuid,p_occurrence_date date)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p recurring_plans%rowtype; v_deleted integer;
begin
 select * into p from recurring_plans where id=p_plan_id for update;
 if p.id is null then raise exception 'schedule unavailable' using errcode='22023'; end if;
 delete from recurring_plan_skips where plan_id=p.id and occurrence_date=p_occurrence_date;
 get diagnostics v_deleted=row_count;
 -- Audited or billed cancellations are history, not disposable generator rows.
 delete from jobs j where j.recurring_plan_id=p.id and j.generation_epoch=p.generation_epoch
  and j.occurrence_date=p_occurrence_date and j.status='canceled'
  and not exists(select 1 from visit_cancellations c where c.job_id=j.id)
  and not exists(select 1 from visit_reschedules r where r.job_id=j.id)
  and not exists(select 1 from recurring_schedule_job_changes r where r.job_id=j.id)
  and not exists(select 1 from invoices i where i.job_id=j.id)
  and not exists(select 1 from job_assignments a where a.job_id=j.id)
  and not exists(select 1 from offers o where o.job_id=j.id);
 return v_deleted>0;
end $$;


-- Narrow, actor-scoped reads avoid adding broad plan SELECT grants (which would
-- also expose agreed cleaner payout shares). These functions return safe fields.
create function public.read_my_recurring_schedules(p_plan uuid default null,p_customer uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not (is_admin() or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'customer_id',p.customer_id,'service',p.service,
  'freq',p.freq,'anchor_date',p.anchor_date,'start_time',p.start_time,'paused_until',p.paused_until,
  'ends_on',p.ends_on,'active',p.active,'agreed_price_cents',p.agreed_price_cents,'horizon_days',p.horizon_days,
  'properties',jsonb_build_object('street',h.street,'city',h.city),
  'recurring_plan_skips',coalesce((select jsonb_agg(jsonb_build_object('occurrence_date',s.occurrence_date) order by s.occurrence_date)
   from recurring_plan_skips s where s.plan_id=p.id),'[]'::jsonb)) order by p.created_at desc,p.id)
  from recurring_plans p join properties h on h.id=p.property_id and h.customer_id=p.customer_id
  where (p.active or p_plan is not null) and p.freq in ('weekly','biweekly','monthly') and (p_plan is null or p.id=p_plan)
   and (p_customer is null or p.customer_id=p_customer) and (is_admin() or p.customer_id=current_customer_id())),'[]'::jsonb);
end $$;
create function public.read_my_visit_schedule_identity(p_job uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype;v_recurring boolean;
begin
 if auth.uid() is null or not (is_admin() or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 select * into j from jobs where id=p_job and (is_admin() or customer_id=current_customer_id());
 if j.id is null then raise exception 'visit unavailable' using errcode='42501';end if;
 v_recurring:=j.occurrence_date is not null and exists(select 1 from recurring_plans p
  where p.id=j.recurring_plan_id and p.customer_id=j.customer_id and p.generation_epoch=j.generation_epoch);
 return jsonb_build_object('status',j.status,'started_at',j.started_at,'recurring',v_recurring);
end $$;
create function public.can_read_recurring_change(p_plan uuid,p_customer uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and (is_admin() or (exists(select 1 from profiles where id=auth.uid() and role='customer')
  and p_customer=current_customer_id() and exists(select 1 from recurring_plans p where p.id=p_plan and p.customer_id=p_customer)))
$$;
drop policy recurring_changes_read on public.recurring_schedule_changes;
create policy recurring_changes_read on public.recurring_schedule_changes for select to authenticated
 using(public.can_read_recurring_change(plan_id,customer_id));
revoke all on function public.read_my_recurring_schedules(uuid,uuid),public.read_my_visit_schedule_identity(uuid),public.can_read_recurring_change(uuid,uuid) from public,anon;
grant execute on function public.read_my_recurring_schedules(uuid,uuid),public.read_my_visit_schedule_identity(uuid),public.can_read_recurring_change(uuid,uuid) to authenticated;

create function public.read_my_recurring_visit_changes(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype;
begin
 if auth.uid() is null or not (is_admin() or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';end if;
 select * into j from jobs where id=p_job and (is_admin() or customer_id=current_customer_id());
 if j.id is null then raise exception 'visit unavailable' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q) order by q.generation_epoch desc) from
  (select x.change_id,x.action,x.previous_start,x.new_start,x.new_price_cents,x.reason,r.generation_epoch,
   jsonb_build_object('plan_id',r.plan_id,'confirmed_at',r.confirmed_at) recurring_schedule_changes
   from recurring_schedule_job_changes x join recurring_schedule_changes r on r.id=x.change_id
   where x.job_id=j.id and can_read_recurring_change(r.plan_id,r.customer_id) order by r.generation_epoch desc limit 3) q),'[]'::jsonb);
end $$;
revoke all on function public.read_my_recurring_visit_changes(uuid) from public,anon;
grant execute on function public.read_my_recurring_visit_changes(uuid) to authenticated;

-- A stale service worker cannot invoice a visit removed by this reviewed edit.
-- The job lock makes an insert before confirmation invalidate the review, and
-- an insert waiting behind confirmation sees the durable removal audit.
create function public.guard_recurring_removed_invoice() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.job_id is not null then
  perform 1 from jobs where id=new.job_id for update;
  if exists(select 1 from recurring_schedule_job_changes where job_id=new.job_id and action='removed') then
   raise exception 'removed recurring visit cannot be invoiced' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
create trigger invoices_recurring_removed_guard before insert on public.invoices for each row execute function public.guard_recurring_removed_invoice();
revoke all on function public.guard_recurring_removed_invoice() from public,anon,authenticated;
create or replace function public.guard_canceled_visit_collection() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_invoice invoices%rowtype;
begin
 select * into v_invoice from invoices where id=new.invoice_id for update;
 if v_invoice.voided_at is not null or v_invoice.status='void'
  or exists(select 1 from visit_cancellations c where c.job_id=v_invoice.job_id and c.invoice_id is distinct from v_invoice.id)
  or exists(select 1 from recurring_schedule_job_changes x where x.job_id=v_invoice.job_id and x.action='removed') then
  raise exception 'invoice unavailable for collection after cancellation' using errcode='23514';
 end if;
 return new;
end $$;
