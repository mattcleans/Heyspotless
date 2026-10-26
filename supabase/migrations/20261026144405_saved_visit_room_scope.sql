-- A home is editable; the room list for an accepted visit is not.
create table public.job_room_scopes (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 customer_id uuid not null,
 property_id uuid not null,
 bedrooms integer not null check(bedrooms between 0 and 250),
 bathrooms integer not null check(bathrooms between 0 and 250),
 half_baths integer not null check(half_baths between 0 and 250),
 kitchens integer not null check(kitchens between 0 and 250),
 living_rooms integer not null check(living_rooms between 0 and 250),
 utility_rooms integer not null check(utility_rooms between 0 and 250),
 source text not null check(source in ('client_booking','client_quote','plan_created','visit_created','legacy_home')),
 captured_at timestamptz not null,
 check(bedrooms+bathrooms+half_baths+kitchens+living_rooms+utility_rooms<=250)
);
alter table public.job_room_scopes enable row level security;
revoke all on public.job_room_scopes from public,anon,authenticated,service_role;
grant select on public.job_room_scopes to authenticated,service_role;
create policy job_room_scopes_read on public.job_room_scopes for select to authenticated using (
 public.is_admin() or exists(select 1 from public.jobs j where j.id=job_room_scopes.job_id
  and j.customer_id=job_room_scopes.customer_id and j.property_id=job_room_scopes.property_id and (
   (public.current_role_of()='customer' and j.customer_id=public.current_customer_id()) or
   (public.current_role_of()='cleaner' and exists(select 1 from public.job_assignments a where a.job_id=j.id and a.cleaner_id=public.current_cleaner_id()))
  ))
);

create table public.recurring_plan_room_scopes (
 plan_id uuid primary key references public.recurring_plans(id) on delete cascade,
 customer_id uuid not null,property_id uuid not null,
 bedrooms integer not null check(bedrooms between 0 and 250),bathrooms integer not null check(bathrooms between 0 and 250),
 half_baths integer not null check(half_baths between 0 and 250),kitchens integer not null check(kitchens between 0 and 250),
 living_rooms integer not null check(living_rooms between 0 and 250),utility_rooms integer not null check(utility_rooms between 0 and 250),
 source text not null check(source in ('client_booking','client_quote','plan_created','legacy_home')),
 captured_at timestamptz not null,
 check(bedrooms+bathrooms+half_baths+kitchens+living_rooms+utility_rooms<=250)
);
alter table public.recurring_plan_room_scopes enable row level security;
revoke all on public.recurring_plan_room_scopes from public,anon,authenticated,service_role;
grant select on public.recurring_plan_room_scopes to authenticated,service_role;
create policy recurring_plan_room_scopes_read on public.recurring_plan_room_scopes for select to authenticated using (
 public.is_admin() or (public.current_role_of()='customer' and exists(select 1 from public.recurring_plans p
  where p.id=recurring_plan_room_scopes.plan_id and p.customer_id=recurring_plan_room_scopes.customer_id
   and p.property_id=recurring_plan_room_scopes.property_id and p.customer_id=public.current_customer_id()))
);

create function spotless_private.room_scope_values(p_home jsonb) returns integer[]
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare vals integer[]:='{}'; k text; v text;
begin
 foreach k in array array['bedroom','bathroom','half_bath','kitchen','living','utility'] loop
  v:=p_home->>k;
  if jsonb_typeof(p_home->k) is distinct from 'number' or v !~ '^[0-9]{1,3}$' then return null;end if;
  vals:=array_append(vals,v::integer);
 end loop;
 if (select sum(n) from unnest(vals)n)>250 then return null;end if;
 return vals;
end $$;
revoke all on function spotless_private.room_scope_values(jsonb) from public,anon,authenticated,service_role;

create function spotless_private.capture_plan_room_scope(p_plan_id uuid,p_legacy boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.recurring_plans%rowtype; h public.properties%rowtype; candidate jsonb; captured timestamptz; origin text; ids uuid[]; vals integer[];
begin
 select * into p from public.recurring_plans where id=p_plan_id for update;
 if p.id is null then return;end if;
 select array_agg(r.id) into ids from spotless_private.client_booking_reviews r where r.plan_id=p.id and r.customer_id=p.customer_id and r.property_id=p.property_id and r.confirmed_at is not null;
 if cardinality(ids)>1 then return;end if;
 if cardinality(ids)=1 then
  select r.home_snapshot,r.created_at into candidate,captured from spotless_private.client_booking_reviews r where r.id=ids[1];origin:='client_booking';
 else
  select array_agg(t.id) into ids from spotless_private.client_quote_terms t join public.quotes q on q.id=t.id
   where t.plan_id=p.id and t.accepted is true and t.state='booked' and q.customer_id=p.customer_id and q.property_id=p.property_id;
  if cardinality(ids)>1 then return;end if;
  if cardinality(ids)=1 then select t.property_snapshot,t.created_at into candidate,captured from spotless_private.client_quote_terms t where t.id=ids[1];origin:='client_quote';end if;
 end if;
 if candidate is null then
  select * into h from public.properties where id=p.property_id and customer_id=p.customer_id for share;
  if h.id is null then return;end if;
  candidate:=jsonb_build_object('id',h.id,'customer',h.customer_id,'bedroom',h.bedrooms,'bathroom',h.bathrooms,'half_bath',h.half_baths,'kitchen',h.kitchens,'living',h.living_rooms,'utility',h.utility_rooms);
  captured:=clock_timestamp();origin:=case when p_legacy then 'legacy_home' else 'plan_created' end;
 end if;
 if candidate->>'id' is distinct from p.property_id::text or candidate->>'customer' is distinct from p.customer_id::text then return;end if;
 vals:=spotless_private.room_scope_values(candidate);if vals is null then return;end if;
 insert into public.recurring_plan_room_scopes(plan_id,customer_id,property_id,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms,source,captured_at)
 values(p.id,p.customer_id,p.property_id,vals[1],vals[2],vals[3],vals[4],vals[5],vals[6],origin,captured)
 on conflict(plan_id) do update set bedrooms=excluded.bedrooms,bathrooms=excluded.bathrooms,half_baths=excluded.half_baths,kitchens=excluded.kitchens,living_rooms=excluded.living_rooms,utility_rooms=excluded.utility_rooms,source=excluded.source,captured_at=excluded.captured_at
 where public.recurring_plan_room_scopes.source='plan_created' and public.recurring_plan_room_scopes.captured_at>=transaction_timestamp()
  and excluded.source in ('client_booking','client_quote')
  and not exists(select 1 from public.jobs j where j.recurring_plan_id=p.id and (j.started_at is not null or j.completed_at is not null or exists(select 1 from public.job_photos ph where ph.job_id=j.id)));
end $$;
revoke all on function spotless_private.capture_plan_room_scope(uuid,boolean) from public,anon,authenticated,service_role;
create function spotless_private.capture_inserted_plan_scope() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin perform spotless_private.capture_plan_room_scope(new.id);return new;end $$;
revoke all on function spotless_private.capture_inserted_plan_scope() from public,anon,authenticated,service_role;
create trigger capture_inserted_plan_scope after insert on public.recurring_plans for each row execute function spotless_private.capture_inserted_plan_scope();
do $$ declare r record;begin for r in select id from public.recurring_plans order by id loop perform spotless_private.capture_plan_room_scope(r.id,true);end loop;end $$;

create function spotless_private.plan_room_scope(p_plan uuid) returns public.recurring_plan_room_scopes
language sql stable set search_path=pg_catalog,pg_temp as $$
 select s from public.recurring_plan_room_scopes s join public.recurring_plans p on p.id=s.plan_id
 where s.plan_id=p_plan and s.customer_id=p.customer_id and s.property_id=p.property_id
$$;
revoke all on function spotless_private.plan_room_scope(uuid) from public,anon,authenticated,service_role;

create function spotless_private.capture_job_room_scope(p_job_id uuid,p_legacy boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype; p public.properties%rowtype; planned public.recurring_plan_room_scopes%rowtype;
 candidate jsonb; captured timestamptz; origin text; ids uuid[]; vals integer[];
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null then return;end if;
 select array_agg(r.id) into ids from spotless_private.client_booking_reviews r
 where (r.job_id=j.id or (j.recurring_plan_id is not null and r.plan_id=j.recurring_plan_id))
  and r.customer_id=j.customer_id and r.property_id=j.property_id and r.confirmed_at is not null;
 if cardinality(ids)>1 then return;end if;
 if cardinality(ids)=1 then
  select r.home_snapshot,r.created_at into candidate,captured from spotless_private.client_booking_reviews r where r.id=ids[1];origin:='client_booking';
 else
  select array_agg(t.id) into ids from spotless_private.client_quote_terms t join public.quotes q on q.id=t.id
  where (t.id=j.quote_id or (j.recurring_plan_id is not null and t.plan_id=j.recurring_plan_id))
   and t.accepted is true and t.state in ('published','booked') and q.customer_id=j.customer_id and q.property_id=j.property_id;
  if cardinality(ids)>1 then return;end if;
  if cardinality(ids)=1 then
   select t.property_snapshot,t.created_at into candidate,captured from spotless_private.client_quote_terms t where t.id=ids[1];origin:='client_quote';
  end if;
 end if;
 if candidate is null and j.recurring_plan_id is not null then
  select * into planned from public.recurring_plan_room_scopes where plan_id=j.recurring_plan_id and customer_id=j.customer_id and property_id=j.property_id for share;
  if planned.plan_id is null then return;end if;
  candidate:=jsonb_build_object('id',planned.property_id,'customer',planned.customer_id,'bedroom',planned.bedrooms,'bathroom',planned.bathrooms,'half_bath',planned.half_baths,'kitchen',planned.kitchens,'living',planned.living_rooms,'utility',planned.utility_rooms);
  captured:=planned.captured_at;origin:=planned.source;
 end if;
 if candidate is null then
  select * into p from public.properties where id=j.property_id and customer_id=j.customer_id for share;
  if p.id is null then return;end if;
  candidate:=jsonb_build_object('id',p.id,'customer',p.customer_id,'bedroom',p.bedrooms,'bathroom',p.bathrooms,'half_bath',p.half_baths,'kitchen',p.kitchens,'living',p.living_rooms,'utility',p.utility_rooms);
  captured:=clock_timestamp();origin:=case when p_legacy then 'legacy_home' else 'visit_created' end;
 end if;
 if candidate->>'id' is distinct from j.property_id::text or candidate->>'customer' is distinct from j.customer_id::text then return;end if;
 vals:=spotless_private.room_scope_values(candidate);
 if vals is null then return;end if;
 insert into public.job_room_scopes(job_id,customer_id,property_id,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms,source,captured_at)
 values(j.id,j.customer_id,j.property_id,vals[1],vals[2],vals[3],vals[4],vals[5],vals[6],origin,captured)
 on conflict(job_id) do update set bedrooms=excluded.bedrooms,bathrooms=excluded.bathrooms,half_baths=excluded.half_baths,kitchens=excluded.kitchens,
  living_rooms=excluded.living_rooms,utility_rooms=excluded.utility_rooms,source=excluded.source,captured_at=excluded.captured_at
 where public.job_room_scopes.source in ('visit_created','plan_created') and excluded.source in ('client_booking','client_quote') and j.created_at>=transaction_timestamp()
  and j.started_at is null and j.completed_at is null and not exists(select 1 from public.job_photos where job_id=j.id);
end $$;
revoke all on function spotless_private.capture_job_room_scope(uuid,boolean) from public,anon,authenticated,service_role;

create function spotless_private.capture_inserted_job_scope() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin perform spotless_private.capture_job_room_scope(new.id);return new;end $$;
revoke all on function spotless_private.capture_inserted_job_scope() from public,anon,authenticated,service_role;
create trigger capture_inserted_job_scope after insert on public.jobs for each row execute function spotless_private.capture_inserted_job_scope();

create function spotless_private.capture_confirmed_booking_scope() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if new.job_id is not null and new.confirmed_at is not null then
  if new.plan_id is not null then perform spotless_private.capture_plan_room_scope(new.plan_id);end if;
  perform spotless_private.capture_job_room_scope(new.job_id);
 end if;
 return new;
end $$;
revoke all on function spotless_private.capture_confirmed_booking_scope() from public,anon,authenticated,service_role;
create trigger capture_confirmed_booking_scope after insert or update of job_id,confirmed_at on spotless_private.client_booking_reviews
 for each row execute function spotless_private.capture_confirmed_booking_scope();

create function spotless_private.capture_booked_quote_scope() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if new.job_id is not null and new.state='booked' and new.accepted is true then
  if new.plan_id is not null then perform spotless_private.capture_plan_room_scope(new.plan_id);end if;
  perform spotless_private.capture_job_room_scope(new.job_id);
 end if;return new;
end $$;
revoke all on function spotless_private.capture_booked_quote_scope() from public,anon,authenticated,service_role;
create trigger capture_booked_quote_scope after update of job_id,plan_id,state on spotless_private.client_quote_terms for each row execute function spotless_private.capture_booked_quote_scope();

-- Agreement receipts win. A missing agreement is explicitly a rollout baseline,
-- never presented as a reconstructed historic Client agreement.
do $$ declare r record;begin
 for r in select id from public.jobs order by id loop perform spotless_private.capture_job_room_scope(r.id,true);end loop;
end $$;

-- Both server gates use the same saved visit scope as the role-specific UI.
create or replace function public.settle_job_invoice(p_job_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 j public.jobs%rowtype; h public.properties%rowtype; s public.job_room_scopes%rowtype; i public.invoices%rowtype;
 keys text[]; ids uuid[];
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or j.status<>'complete' then return null; end if;
 -- A fee is not a service invoice. Never create a replacement for an existing
 -- service bill (including a deliberately voided bill) or an ambiguous record.
 perform 1 from public.invoices where job_id=j.id and kind='service' order by id for update;
 select array_agg(id order by created_at,id) into ids from public.invoices where job_id=j.id and kind='service';
 if cardinality(ids)>0 then
  if cardinality(ids)<>1 then return null; end if;
  select * into i from public.invoices where id=ids[1];
  if i.customer_id<>j.customer_id or i.voided_at is not null or i.status='void' then return null; end if;
  update public.jobs set invoiced_at=coalesce(invoiced_at,i.created_at) where id=j.id;
  return i.id;
 end if;
 if j.invoiced_at is not null or j.price_cents is null or j.price_cents<0 then return null; end if;
 select * into h from public.properties where id=j.property_id for share;
 if h.id is null or h.customer_id<>j.customer_id then return null; end if;
 select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id for share;
 if s.job_id is null then return null;end if;
 begin
  keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
 exception when invalid_parameter_value then return null; end;
 -- Count the exact before/after slots, backed by their exact private objects.
 -- Arbitrary room names, issue photos and metadata without bytes do not count.
 perform 1 from storage.objects o join public.job_photos p on o.bucket_id='job-photos' and o.name=p.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
 where p.job_id=j.id and p.room_key=any(keys) and p.kind in ('before','after') order by o.id for share of o;
 if exists(
  select 1 from unnest(keys) r cross join (values('before'),('after')) k(kind)
  where not exists(select 1 from public.job_photos p join storage.objects o
   on o.bucket_id='job-photos' and o.name=p.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
   where p.job_id=j.id and p.room_key=r and p.kind=k.kind
    and p.storage_path='jobs/'||j.id::text||'/'||r||'-'||k.kind||'.jpg')
 ) then return null; end if;
 insert into public.invoices(job_id,customer_id,kind,status,subtotal_cents,total_cents)
 values(j.id,j.customer_id,'service','draft',j.price_cents,j.price_cents) returning id into i.id;
 update public.jobs set invoiced_at=clock_timestamp() where id=j.id;
 return i.id;
end $$;
revoke all on function public.settle_job_invoice(uuid) from public,anon,authenticated;
grant execute on function public.settle_job_invoice(uuid) to service_role;

create or replace function public.record_job_photo(
 p_job_id uuid,p_cleaner_id uuid,p_storage_path text,p_kind text,p_room_key text
) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype; h public.properties%rowtype; s public.job_room_scopes%rowtype; keys text[]; photo_id uuid;
begin
 -- Assignment changes also lock this visit. The receipt cannot race a release.
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or j.status not in ('assigned','in_progress','complete') or
  not exists(select 1 from public.job_assignments where job_id=j.id and cleaner_id=p_cleaner_id) then
  raise insufficient_privilege using message='The photo cannot be recorded for this assignment.';
 end if;
 select * into h from public.properties where id=j.property_id for share;
 if h.id is null or h.customer_id<>j.customer_id then raise invalid_parameter_value; end if;
 select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id for share;
 if s.job_id is null then raise invalid_parameter_value using message='The saved visit room list needs office review.';end if;
 keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
 if p_kind is null or p_kind not in ('before','after','issue') or p_room_key is null or not(p_room_key=any(keys))
  or p_storage_path is distinct from 'jobs/'||j.id::text||'/'||p_room_key||'-'||p_kind||'.jpg' then
  raise invalid_parameter_value using message='The photo does not match a required visit slot.';
 end if;
 perform 1 from storage.objects where bucket_id='job-photos' and name=p_storage_path and archived_at is null and not coalesce(is_delete_marker,false) for share;
 if not found then raise exception using errcode='PPH01',message='The uploaded photo could not be confirmed.'; end if;
 if p_kind='issue' then
  select id into photo_id from public.job_photos where job_id=j.id and room_key=p_room_key and kind='issue' and storage_path=p_storage_path order by taken_at,id limit 1;
 end if;
 if photo_id is null then
 insert into public.job_photos(job_id,cleaner_id,storage_path,kind,room_key)
 values(j.id,p_cleaner_id,p_storage_path,p_kind,p_room_key)
 on conflict(job_id,room_key,kind) where room_key is not null and kind in ('before','after')
 do update set storage_path=excluded.storage_path,cleaner_id=excluded.cleaner_id,taken_at=clock_timestamp()
 where public.job_photos.storage_path is distinct from excluded.storage_path
 returning id into photo_id;
 end if;
 if photo_id is null then
  select id into photo_id from public.job_photos where job_id=j.id and room_key=p_room_key and kind=p_kind and storage_path=p_storage_path;
 end if;
 if photo_id is null then raise exception using errcode='PPH01',message='The saved photo slot needs review.'; end if;
 perform public.settle_job_invoice(j.id);
 return photo_id;
end $$;
revoke all on function public.record_job_photo(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_job_photo(uuid,uuid,text,text,text) to service_role;


-- Cadence repricing and its confirmation fingerprint use the same saved plan scope.
CREATE OR REPLACE FUNCTION public.recurring_edit_snapshot(p_plan uuid, p_from date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select jsonb_build_object(
  'plan',to_jsonb(p)-'last_generated_at'-'next_job_date',
  'room_scope',to_jsonb(spotless_private.plan_room_scope(p.id)),
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
$function$;

CREATE OR REPLACE FUNCTION public.preview_recurring_edit(p_plan uuid, p_first date, p_freq frequency, p_time time without time zone, p_pause date, p_end date, p_from date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare p recurring_plans%rowtype; h properties%rowtype; j jobs%rowtype;
 saved public.recurring_plan_room_scopes%rowtype;
 v_price integer; v_minutes integer; v_dates date[]:='{}'; v_used date[]:='{}';
 v_date date; v_slot date; v_start timestamptz; v_reason text; v_action text;
 v_visits jsonb:='[]'; v_protected boolean; v_distance integer; v_release integer;
 v_changed boolean;
begin
 select * into p from recurring_plans where id=p_plan;
 select * into h from properties where id=p.property_id;
 if p.id is null or h.id is null or h.customer_id is distinct from p.customer_id or not p.active then
  raise exception 'schedule unavailable' using errcode='PT409';
 end if;
 if exists(select 1 from jobs where recurring_plan_id=p.id and status<>'canceled'
  and (occurrence_date>=p_from or (scheduled_start at time zone 'America/Chicago')::date>=p_from)
  and (customer_id is distinct from p.customer_id or property_id is distinct from p.property_id or service is distinct from p.service)) then
  raise exception 'schedule ownership needs office review' using errcode='PT409';
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
  raise exception 'this schedule needs office review' using errcode='PT409';
 end if;
 select * into saved from spotless_private.plan_room_scope(p.id);
 v_price:=p.agreed_price_cents; v_minutes:=p.estimated_minutes;
 if p_freq<>p.freq then
  if saved.plan_id is null then raise exception 'Review this schedule room list with the office before changing frequency' using errcode='PT409';end if;
  if not exists(select 1 from price_book_items i join price_book_rates r on r.item_id=i.id where i.active and i.service=p.service and r.freq=p_freq) then
   raise exception 'frequency unavailable for this service' using errcode='22023';
  end if;
  select q.total_cents,q.clean_minutes into v_price,v_minutes from quote_price(p.service,p_freq,
   saved.bedrooms,saved.bathrooms,saved.half_baths,saved.kitchens,saved.living_rooms,saved.utility_rooms) q;
  v_price:=v_price+coalesce((select sum((l->>'totalCents')::integer) from jsonb_array_elements(p.quote_extras) l),0);
  v_minutes:=v_minutes+coalesce((select sum((l->>'cleanMinutes')::integer) from jsonb_array_elements(p.quote_extras) l),0);
 end if;
 if v_price is null or v_price<0 or v_minutes is null or v_minutes<=0 then
  raise exception 'a current service price is required' using errcode='PT409';
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
  'room_counts',case when saved.plan_id is null then null else jsonb_build_object('bedrooms',saved.bedrooms,'bathrooms',saved.bathrooms,'halfBaths',saved.half_baths,'kitchens',saved.kitchens,'livingRooms',saved.living_rooms,'utilityRooms',saved.utility_rooms) end,
  'room_scope_source',saved.source,
  'preserved_skips',coalesce((select jsonb_agg(occurrence_date order by occurrence_date) from recurring_plan_skips where plan_id=p.id and occurrence_date>=p_from),'[]'::jsonb));
end $function$;
