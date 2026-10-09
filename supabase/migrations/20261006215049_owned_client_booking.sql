-- One price-book calculation shared by Office quotes and owned Client reviews.
-- Invoker-only, private and not executable by API roles. Ownership is enforced
-- by each authenticated entry point before this helper is called.
create function spotless_private.price_saved_home(p_property_id uuid,p_service public.service_type,p_freq public.frequency,p_extras jsonb)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare p public.properties%rowtype;v_lines jsonb:='[]';v_total integer:=0;v_minutes integer:=0;
 v_qty integer;r record;x jsonb;e public.price_book_extras%rowtype;v_seen text[]:='{}';v_work text:='';
begin
 if p_service is null or p_freq is null or p_extras is null or jsonb_typeof(p_extras)<>'array' or jsonb_array_length(p_extras)>30
 or (p_service='deep' and p_freq not in ('one_time','monthly')) or (p_service='move_in_out' and p_freq<>'one_time') then
  raise exception 'Invalid service or extras' using errcode='22023';end if;
 select * into p from public.properties where id=p_property_id for share;
 if p.id is null then raise exception 'Saved home unavailable' using errcode='23514';end if;
 -- Lock the actual price book; no browser-supplied totals, minutes or room counts.
 perform i.id from price_book_items i join price_book_rates rate on rate.item_id=i.id where i.service=p_service and i.active and rate.freq=p_freq for share of i,rate;
 for r in select * from (values('arrival',1),('bedroom',p.bedrooms),('bathroom',p.bathrooms),('half_bath',p.half_baths),('kitchen',p.kitchens),('living',p.living_rooms),('utility',p.utility_rooms)) s(key,qty) loop
  if r.qty<0 or r.qty>30 then raise exception 'Check saved room counts' using errcode='23514';end if;
  if r.qty=0 then continue;end if;
  select jsonb_build_object('itemKey',i.item_key,'name',i.name,'quantity',r.qty,'unitPriceCents',b.price_cents,
    'totalCents',r.qty*b.price_cents,'cleanMinutes',r.qty*i.clean_minutes,'isExtra',false) into x
    from price_book_items i join price_book_rates b on b.item_id=i.id where i.service=p_service and i.item_key=r.key and i.active and b.freq=p_freq;
  if x is null or (x->>'unitPriceCents')::integer<0 then raise exception 'Missing price book rate' using errcode='23514';end if;
  v_lines:=v_lines||jsonb_build_array(x);v_total:=v_total+(x->>'totalCents')::integer;v_minutes:=v_minutes+(x->>'cleanMinutes')::integer;
 end loop;
 for x in select value from jsonb_array_elements(p_extras) loop
  if jsonb_typeof(x)<>'object' or (select count(*) from jsonb_object_keys(x))<>2 or not x ? 'itemKey' or not x ? 'quantity'
  or jsonb_typeof(x->'itemKey')<>'string' or jsonb_typeof(x->'quantity')<>'number' or (x->>'quantity')!~'^[1-9][0-9]?$' then raise exception 'Invalid extra' using errcode='22023';end if;
  v_qty:=(x->>'quantity')::integer;
  if v_qty>20 or x->>'itemKey'=any(v_seen) then raise exception 'Duplicate or excessive extra' using errcode='22023';end if;
  v_seen:=array_append(v_seen,x->>'itemKey');
  select * into e from price_book_extras where item_key=x->>'itemKey' and active for share;
  if e.id is null or e.price_cents<0 or e.clean_minutes<0 then raise exception 'Extra unavailable' using errcode='23514';end if;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('itemKey',e.item_key,'name',e.name||case when e.unit_label='flat' then '' else ' ('||e.unit_label||')' end,'quantity',v_qty,'unitPriceCents',e.price_cents,
   'totalCents',v_qty*e.price_cents,'cleanMinutes',v_qty*e.clean_minutes,'isExtra',true));
  v_total:=v_total+v_qty*e.price_cents;v_minutes:=v_minutes+v_qty*e.clean_minutes;
  v_work:=v_work||case when v_work='' then '' else E'\n' end||e.name||' × '||v_qty||case when e.unit_label='flat' then '' else ' ('||e.unit_label||')' end;
 end loop;
 if v_total<=0 or v_minutes<=0 then raise exception 'Invalid price book' using errcode='23514';end if;
 return jsonb_build_object('lines',v_lines,'totalCents',v_total,'estimatedMinutes',v_minutes,'workNotes',v_work);
end $$;
revoke all on function spotless_private.price_saved_home(uuid,public.service_type,public.frequency,jsonb) from public,anon,authenticated,service_role;

create or replace function public.prepare_client_quote(p_id uuid,p_property_id uuid,p_service service_type,p_freq frequency,
 p_start timestamptz,p_expires timestamptz,p_repeats boolean,p_extras jsonb,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p properties%rowtype;c customers%rowtype;t spotless_private.client_quote_terms%rowtype;v_input jsonb;v_home jsonb;
 v_lines jsonb:='[]';v_total integer:=0;v_minutes integer:=0;v_qty integer;r record;x jsonb;e price_book_extras%rowtype;v_seen text[]:='{}';v_work text:='';v_priced jsonb;begin
 if auth.uid() is null or not is_admin() then raise insufficient_privilege;end if;
 if p_id is null or p_property_id is null or p_service is null or p_freq is null or p_start is null or p_expires is null or p_repeats is null
 or p_note is null or length(p_note)>1500 or p_extras is null or jsonb_typeof(p_extras)<>'array' then raise exception 'Check quote details' using errcode='22023';end if;
 v_input:=jsonb_build_object('property',p_property_id,'service',p_service,'frequency',p_freq,'start',p_start,'expires',p_expires,'repeats',p_repeats,'extras',p_extras,'note',btrim(p_note));
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,52931));
 -- Same request always returns the prepared terms, including after price changes.
 select * into t from spotless_private.client_quote_terms where id=p_id for update;
 if t.id is not null then
  if t.creator<>auth.uid() or t.input is distinct from v_input then raise exception 'Request already used' using errcode='PT409';end if;
  return spotless_private.quote_view(t.id);
 end if;
 if not isfinite(p_start) or not isfinite(p_expires) or p_start<=clock_timestamp() or p_start>clock_timestamp()+interval '366 days'
 or p_expires<=clock_timestamp() or p_expires>p_start or date_trunc('minute',p_start)<>p_start
 or (p_repeats and p_freq='one_time') or (p_service='deep' and p_freq not in ('one_time','monthly'))
 or (p_service='move_in_out' and p_freq<>'one_time') or jsonb_array_length(p_extras)>30 then raise exception 'Invalid quote dates or cadence' using errcode='22023';end if;
 select * into p from properties where id=p_property_id for share;
 select * into c from customers where id=p.customer_id for share;
 if p.id is null or c.profile_id is null or not exists(select 1 from profiles where id=c.profile_id and role='customer') then
  raise exception 'Connect the client account before publishing a quote' using errcode='23514';end if;
 v_home:=spotless_private.quote_home(p.id);
 v_priced:=spotless_private.price_saved_home(p.id,p_service,p_freq,p_extras);
 v_lines:=v_priced->'lines';v_total:=(v_priced->>'totalCents')::integer;
 v_minutes:=(v_priced->>'estimatedMinutes')::integer;v_work:=v_priced->>'workNotes';
 if p_repeats and recurring_start_at((p_start at time zone 'America/Chicago')::date,(p_start at time zone 'America/Chicago')::time)<>p_start then
  raise exception 'Review the first Dallas time for recurrence' using errcode='22023';end if;
 insert into quotes(id,customer_id,property_id,service,freq,total_cents,subtotal_cents,estimated_minutes,expires_on,client_managed)
 values(p_id,c.id,p.id,p_service,p_freq,v_total,v_total,v_minutes,(p_expires at time zone 'America/Chicago')::date,true);
 insert into spotless_private.client_quote_terms(id,creator,client_profile,input,property_snapshot,lines,proposed_start,expires_at,repeats,client_note,work_notes)
 values(p_id,auth.uid(),c.profile_id,v_input,v_home,v_lines,p_start,p_expires,p_repeats,btrim(p_note),v_work);
 insert into quote_line_items(quote_id,item_key,name,quantity,unit_price_cents,total_cents,clean_minutes,sort_order)
 select p_id,l->>'itemKey',l->>'name',(l->>'quantity')::integer,(l->>'unitPriceCents')::integer,(l->>'totalCents')::integer,(l->>'cleanMinutes')::integer,n::integer
 from jsonb_array_elements(v_lines) with ordinality a(l,n);
 return spotless_private.quote_view(p_id);
end $$;

-- Client reviews are private receipts, never a new lead or payment consent.
create table spotless_private.client_booking_reviews (
 id uuid primary key,
 actor uuid not null references public.profiles(id),
 customer_id uuid not null references public.customers(id),
 property_id uuid not null references public.properties(id),
 input jsonb not null,
 home_snapshot jsonb not null,
 lines jsonb not null,
 total_cents integer not null check(total_cents>0),
 estimated_minutes integer not null check(estimated_minutes>0),
 service public.service_type not null,
 freq public.frequency not null,
 requested_start timestamptz not null,
 repeats boolean not null,
 note text not null,
 work_notes text not null,
 expires_at timestamptz not null,
 job_id uuid unique references public.jobs(id) on delete set null,
 plan_id uuid unique references public.recurring_plans(id) on delete set null,
 confirmed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index client_booking_reviews_actor on spotless_private.client_booking_reviews(actor,created_at desc,id);
create index client_booking_reviews_open on spotless_private.client_booking_reviews(actor,expires_at) where confirmed_at is null;
alter table spotless_private.client_booking_reviews enable row level security;
revoke all on spotless_private.client_booking_reviews from public,anon,authenticated,service_role;
create table spotless_private.client_booking_home_locks (
 property_id uuid primary key references public.properties(id) on delete cascade
);
alter table spotless_private.client_booking_home_locks enable row level security;
revoke all on spotless_private.client_booking_home_locks from public,anon,authenticated,service_role;

create function spotless_private.client_booking_view(p_id uuid) returns jsonb
language sql volatile set search_path=public,pg_temp as $$
 select jsonb_build_object('id',r.id,'propertyId',r.property_id,'home',r.home_snapshot,
 'service',r.service,'frequency',r.freq,'requestedStart',r.requested_start,'repeats',r.repeats,
 'lines',r.lines,'totalCents',r.total_cents,'estimatedMinutes',r.estimated_minutes,
 'note',r.note,'expiresAt',r.expires_at,'jobId',case when j.id is not null then r.job_id end,
 'planId',case when j.id is not null then r.plan_id end,
 'state',case when r.confirmed_at is not null then
   case when j.id is null then 'unavailable' when j.status='canceled' then 'canceled' else 'requested' end
  when r.home_snapshot is distinct from spotless_private.quote_home(r.property_id) then 'stale'
  when r.expires_at<=clock_timestamp() or r.requested_start<=clock_timestamp() then 'expired' else 'review' end)
 from spotless_private.client_booking_reviews r left join public.jobs j on j.id=r.job_id
 and j.customer_id=r.customer_id and j.property_id=r.property_id where r.id=p_id
$$;
revoke all on function spotless_private.client_booking_view(uuid) from public,anon,authenticated,service_role;

create function public.review_my_booking(p_id uuid,p_property_id uuid,p_service public.service_type,
 p_freq public.frequency,p_start timestamptz,p_repeats boolean,p_extras jsonb,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.customers%rowtype;p public.properties%rowtype;r spotless_private.client_booking_reviews%rowtype;
 v_input jsonb;v_price jsonb;
begin
 if auth.uid() is null or public.current_role_of() is distinct from 'customer' then raise insufficient_privilege;end if;
 perform id from public.profiles where id=auth.uid() and role='customer' for share;
 if not found then raise insufficient_privilege;end if;
 select * into c from public.customers where profile_id=auth.uid() for update;
 if c.id is null then raise insufficient_privilege;end if;
 if p_id is null or p_property_id is null or p_service is null or p_freq is null or p_start is null
 or p_repeats is null or p_note is null or length(p_note)>1500 or p_extras is null
 or jsonb_typeof(p_extras)<>'array' or jsonb_array_length(p_extras)>30 then
  raise exception 'Check booking details' using errcode='22023';end if;
 v_input:=jsonb_build_object('property',p_property_id,'service',p_service,'frequency',p_freq,
  'start',p_start,'repeats',p_repeats,'extras',p_extras,'note',btrim(p_note));
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,61453));
 select * into r from spotless_private.client_booking_reviews where id=p_id for update;
 if r.id is not null then
  if r.actor<>auth.uid() or r.customer_id<>c.id then raise insufficient_privilege;end if;
  if r.input is distinct from v_input then raise exception 'Review already used' using errcode='PT409';end if;
  return spotless_private.client_booking_view(r.id);
 end if;
 if not isfinite(p_start) or p_start<=clock_timestamp() or p_start>clock_timestamp()+interval '366 days'
 or date_trunc('minute',p_start)<>p_start or (p_repeats and p_freq='one_time') then
  raise exception 'Choose a future appointment and valid repeat choice' using errcode='22023';end if;
 select * into p from public.properties where id=p_property_id and customer_id=c.id for share;
 if p.id is null then raise insufficient_privilege;end if;
 if p_repeats and public.recurring_start_at((p_start at time zone 'America/Chicago')::date,
  (p_start at time zone 'America/Chicago')::time)<>p_start then
  raise exception 'Review the first Dallas time for recurrence' using errcode='22023';end if;
 if (select count(*) from spotless_private.client_booking_reviews where actor=auth.uid()
  and confirmed_at is null and expires_at>clock_timestamp())>=20 then
  raise exception 'Finish or let an existing review expire first' using errcode='PBR01';end if;
 v_price:=spotless_private.price_saved_home(p.id,p_service,p_freq,p_extras);
 insert into spotless_private.client_booking_reviews(id,actor,customer_id,property_id,input,home_snapshot,
  lines,total_cents,estimated_minutes,service,freq,requested_start,repeats,note,work_notes,expires_at)
 values(p_id,auth.uid(),c.id,p.id,v_input,spotless_private.quote_home(p.id),v_price->'lines',
  (v_price->>'totalCents')::integer,(v_price->>'estimatedMinutes')::integer,p_service,p_freq,p_start,
  p_repeats,btrim(p_note),v_price->>'workNotes',clock_timestamp()+interval '5 minutes');
 return spotless_private.client_booking_view(p_id);
end $$;

create function public.confirm_my_booking(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r spotless_private.client_booking_reviews%rowtype;c public.customers%rowtype;
 p public.properties%rowtype;v_plan uuid;v_job uuid;v_day date;v_notes text;
begin
 if auth.uid() is null or public.current_role_of() is distinct from 'customer' then raise insufficient_privilege;end if;
 perform id from public.profiles where id=auth.uid() and role='customer' for share;
 if not found then raise insufficient_privilege;end if;
 select * into c from public.customers where profile_id=auth.uid() for share;
 if c.id is null then raise insufficient_privilege;end if;
 -- UPDATE forces repeatable-read callers to retry rather than reuse an old receipt.
 update spotless_private.client_booking_reviews set id=id where id=p_id
  and actor=auth.uid() and customer_id=c.id returning * into r;
 if r.id is null then raise insufficient_privilege;end if;
 if r.confirmed_at is not null then return spotless_private.client_booking_view(r.id);end if;
 -- Serialize competing requests for this home, including two different review IDs.
 -- A versioned private row also forces repeatable-read conflicts to retry.
 insert into spotless_private.client_booking_home_locks(property_id) values(r.property_id)
 on conflict(property_id) do update set property_id=excluded.property_id;
 select * into p from public.properties where id=r.property_id and customer_id=c.id for share;
 if p.id is null then raise insufficient_privilege;end if;
 if r.expires_at<=clock_timestamp() or r.requested_start<=clock_timestamp()
 or r.home_snapshot is distinct from spotless_private.quote_home(p.id) then
  raise exception 'Review changed or expired' using errcode='PT409';end if;
 if exists(select 1 from public.jobs j where j.property_id=p.id and j.status not in ('canceled','complete')
  and j.scheduled_start is not null and
  tstzrange(j.scheduled_start,j.scheduled_start+make_interval(mins=>greatest(1,j.estimated_clean_minutes)),'[)') &&
  tstzrange(r.requested_start,r.requested_start+make_interval(mins=>r.estimated_minutes),'[)')) then
  raise exception 'Another visit already uses this time for your home' using errcode='PBO01';end if;
 v_day:=(r.requested_start at time zone 'America/Chicago')::date;
 v_notes:=concat_ws(E'\n',nullif(r.work_notes,''),nullif(r.note,''));
 if r.repeats then
  insert into public.recurring_plans(customer_id,property_id,service,freq,anchor_date,start_time,next_job_date,
   agreed_price_cents,estimated_minutes,notes,quote_extras)
  values(c.id,p.id,r.service,r.freq,v_day,(r.requested_start at time zone 'America/Chicago')::time,v_day,
   r.total_cents,r.estimated_minutes,v_notes,coalesce((select jsonb_agg(l) from jsonb_array_elements(r.lines) l
    where (l->>'isExtra')::boolean),'[]'::jsonb)) returning id into v_plan;
  select job_id into v_job from public.materialise_recurring_job(v_plan,v_day,r.requested_start);
  if v_job is null then raise exception 'First visit not created' using errcode='PT409';end if;
 else
  insert into public.jobs(customer_id,property_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes,notes)
  values(c.id,p.id,'scheduled',r.service,r.freq,r.requested_start,r.total_cents,r.estimated_minutes,v_notes)
  returning id into v_job;
 end if;
 update spotless_private.client_booking_reviews set confirmed_at=clock_timestamp(),job_id=v_job,plan_id=v_plan where id=r.id;
 return spotless_private.client_booking_view(r.id);
end $$;

create function public.read_my_booking_reviews() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid;begin
 if auth.uid() is null or public.current_role_of() is distinct from 'customer' then raise insufficient_privilege;end if;
 select id into c from public.customers where profile_id=auth.uid();
 if c is null then raise insufficient_privilege;end if;
 return coalesce((select jsonb_agg(spotless_private.client_booking_view(r.id) order by r.created_at desc,r.id)
  from (select id,created_at from spotless_private.client_booking_reviews where actor=auth.uid() and customer_id=c
   order by created_at desc,id limit 20) r),'[]'::jsonb);
end $$;
revoke all on function public.review_my_booking(uuid,uuid,public.service_type,public.frequency,timestamptz,boolean,jsonb,text),
 public.confirm_my_booking(uuid),public.read_my_booking_reviews() from public,anon,authenticated,service_role;
grant execute on function public.review_my_booking(uuid,uuid,public.service_type,public.frequency,timestamptz,boolean,jsonb,text),
 public.confirm_my_booking(uuid),public.read_my_booking_reviews() to authenticated;
