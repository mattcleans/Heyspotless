-- Account-only quotes. No provider sends, payment consent or dispatch side effects.
alter table public.recurring_plans add column quote_extras jsonb not null default '[]' check(jsonb_typeof(quote_extras)='array');
alter table public.quotes add column client_managed boolean not null default false;
alter policy quotes_own on public.quotes using(customer_id=current_customer_id() and not client_managed);
create table spotless_private.client_quote_terms (
 id uuid primary key references public.quotes(id) on delete cascade,
 creator uuid not null references public.profiles(id),
 client_profile uuid not null references public.profiles(id),
 input jsonb not null,
 property_snapshot jsonb not null,
 lines jsonb not null,
 proposed_start timestamptz not null,
 expires_at timestamptz not null,
 repeats boolean not null,
 client_note text not null,
 work_notes text not null,
 state text not null default 'review' check(state in ('review','published','withdrawn','booked')),
 version integer not null default 0 check(version>=0),
 accepted boolean,
 decided_by uuid references public.profiles(id),
 decision_id uuid,
 job_id uuid references public.jobs(id) on delete set null,
 plan_id uuid references public.recurring_plans(id) on delete set null,
 booked_version integer,
 created_at timestamptz not null default clock_timestamp()
);
create table spotless_private.client_quote_decisions (
 id uuid primary key,
 quote_id uuid not null references spotless_private.client_quote_terms(id) on delete cascade,
 actor uuid not null references public.profiles(id),
 expected_version integer not null,
 accepted boolean not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table spotless_private.client_quote_terms enable row level security;
alter table spotless_private.client_quote_decisions enable row level security;
revoke all on spotless_private.client_quote_terms,spotless_private.client_quote_decisions from public,anon,authenticated,service_role;

create function spotless_private.quote_home(p_id uuid) returns jsonb language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',p.id,'customer',p.customer_id,'street',p.street,'city',p.city,'state',p.state,'zip',p.zip,
 'bedroom',p.bedrooms,'bathroom',p.bathrooms,'half_bath',p.half_baths,'kitchen',p.kitchens,'living',p.living_rooms,'utility',p.utility_rooms)
 from properties p where id=p_id
$$;
create function spotless_private.quote_view(p_id uuid) returns jsonb language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',q.id,'customerId',q.customer_id,'propertyId',q.property_id,'service',q.service,'frequency',q.freq,
 'totalCents',q.total_cents,'estimatedMinutes',q.estimated_minutes,'lines',t.lines,'home',t.property_snapshot,
 'proposedStart',t.proposed_start,'expiresAt',t.expires_at,'repeats',t.repeats,'note',t.client_note,'version',t.version,
 'decisionId',t.decision_id,'accepted',t.accepted,'jobId',t.job_id,'planId',t.plan_id,
 'state',case when t.state='booked' then 'booked' when t.state='withdrawn' then 'withdrawn'
   when t.property_snapshot is distinct from spotless_private.quote_home(q.property_id) or t.client_profile is distinct from c.profile_id or not exists(select 1 from profiles where id=t.client_profile and role='customer') then 'stale'
   when t.expires_at<=clock_timestamp() or t.proposed_start<=clock_timestamp() then 'expired'
   when t.state='review' then 'review' when t.accepted is true then 'accepted' when t.accepted is false then 'declined' else 'published' end)
 from quotes q join spotless_private.client_quote_terms t on t.id=q.id join customers c on c.id=q.customer_id where q.id=p_id
$$;
create function public.read_client_quotes(p_customer_id uuid default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_customer uuid;begin
 if auth.uid() is null then raise insufficient_privilege;end if;
 if is_admin() then v_customer:=p_customer_id;
 elsif current_role_of()='customer' then
  v_customer:=current_customer_id();
  if v_customer is null or (p_customer_id is not null and p_customer_id<>v_customer) then raise insufficient_privilege;end if;
 else raise insufficient_privilege;end if;
 return coalesce((select jsonb_agg(spotless_private.quote_view(q.id) order by t.created_at desc)
  from quotes q join spotless_private.client_quote_terms t on t.id=q.id join customers c on c.id=q.customer_id
  where (v_customer is null or q.customer_id=v_customer) and (is_admin() or (t.state<>'review' and t.client_profile=auth.uid() and c.profile_id=auth.uid()))),'[]'::jsonb);
end $$;
create function public.prepare_client_quote(p_id uuid,p_property_id uuid,p_service service_type,p_freq frequency,
 p_start timestamptz,p_expires timestamptz,p_repeats boolean,p_extras jsonb,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p properties%rowtype;c customers%rowtype;t spotless_private.client_quote_terms%rowtype;v_input jsonb;v_home jsonb;
 v_lines jsonb:='[]';v_total integer:=0;v_minutes integer:=0;v_qty integer;r record;x jsonb;e price_book_extras%rowtype;v_seen text[]:='{}';v_work text:='';begin
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
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('itemKey',e.item_key,'name',e.name,'quantity',v_qty,'unitPriceCents',e.price_cents,
   'totalCents',v_qty*e.price_cents,'cleanMinutes',v_qty*e.clean_minutes,'isExtra',true));
  v_total:=v_total+v_qty*e.price_cents;v_minutes:=v_minutes+v_qty*e.clean_minutes;
  v_work:=v_work||case when v_work='' then '' else E'\n' end||e.name||' × '||v_qty;
 end loop;
 if v_total<=0 or v_minutes<=0 then raise exception 'Invalid price book' using errcode='23514';end if;
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
create function spotless_private.lock_quote(p_id uuid) returns spotless_private.client_quote_terms
language plpgsql set search_path=public,pg_temp as $$
declare t spotless_private.client_quote_terms%rowtype;q quotes%rowtype;c customers%rowtype;begin
 -- UPDATE forces concurrent repeatable-read callers to retry instead of seeing old decisions.
 update spotless_private.client_quote_terms set version=version where id=p_id returning * into t;
 if t.id is null then raise insufficient_privilege;end if;
 select * into q from quotes where id=p_id for update;
 select * into c from customers where id=q.customer_id for share;
 perform id from properties where id=q.property_id for share;
 if t.state in ('withdrawn','booked') then return t;end if;
 if t.expires_at<=clock_timestamp() or t.proposed_start<=clock_timestamp()
 or t.client_profile is distinct from c.profile_id or not exists(select 1 from profiles where id=t.client_profile and role='customer') or t.property_snapshot is distinct from spotless_private.quote_home(q.property_id)
 or q.total_cents<>(select sum((l->>'totalCents')::integer) from jsonb_array_elements(t.lines) l)
 or q.subtotal_cents<>q.total_cents or q.estimated_minutes<>(select sum((l->>'cleanMinutes')::integer) from jsonb_array_elements(t.lines) l)
 or q.service::text<>t.input->>'service' or q.freq::text<>t.input->>'frequency'
 or q.property_id<>(t.input->>'property')::uuid or q.customer_id<>(t.property_snapshot->>'customer')::uuid then
  raise exception 'Quote terms changed or expired. Prepare a new quote.' using errcode='PT409';end if;
 return t;
end $$;
create function public.publish_client_quote(p_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare t spotless_private.client_quote_terms%rowtype;begin
 if auth.uid() is null or not is_admin() then raise insufficient_privilege;end if;
 t:=spotless_private.lock_quote(p_id);
 if t.state='published' then return spotless_private.quote_view(p_id);end if;
 if t.state<>'review' then raise exception 'Quote is no longer publishable' using errcode='PT409';end if;
 update spotless_private.client_quote_terms set state='published',version=version+1 where id=p_id;
 update quotes set status='sent',sent_at=clock_timestamp() where id=p_id;
 return spotless_private.quote_view(p_id);
end $$;
create function public.decide_client_quote(p_id uuid,p_request uuid,p_version integer,p_accept boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t spotless_private.client_quote_terms%rowtype;d spotless_private.client_quote_decisions%rowtype;begin
 if auth.uid() is null or current_role_of() is distinct from 'customer' or not exists(select 1 from quotes where id=p_id and customer_id=current_customer_id()) then raise insufficient_privilege;end if;
 if p_request is null or p_version is null or p_version<0 or p_accept is null then raise exception 'Decision required' using errcode='22023';end if;
 -- Check ownership before returning even an old retry receipt.
 update spotless_private.client_quote_terms set version=version where id=p_id returning * into t;
 if t.id is null or t.client_profile<>auth.uid() or t.state='review' then raise insufficient_privilege;end if;
 select * into d from spotless_private.client_quote_decisions where id=p_request;
 if d.id is not null then
  if d.quote_id<>p_id or d.actor<>auth.uid() or d.expected_version<>p_version or d.accepted<>p_accept then raise exception 'Request already used' using errcode='PT409';end if;
  return spotless_private.quote_view(p_id);
 end if;
 t:=spotless_private.lock_quote(p_id);
 if t.state<>'published' or t.version<>p_version then raise exception 'Quote or decision changed. Refresh first.' using errcode='PT409';end if;
 insert into spotless_private.client_quote_decisions(id,quote_id,actor,expected_version,accepted) values(p_request,p_id,auth.uid(),p_version,p_accept);
 update spotless_private.client_quote_terms set accepted=p_accept,decided_by=auth.uid(),decision_id=p_request,version=version+1 where id=p_id;
 update quotes set status=case when p_accept then 'approved'::quote_status else 'declined'::quote_status end,responded_at=clock_timestamp() where id=p_id;
 return spotless_private.quote_view(p_id);
end $$;
create function public.withdraw_client_quote(p_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare t spotless_private.client_quote_terms%rowtype;begin
 if auth.uid() is null or not is_admin() then raise insufficient_privilege;end if;
 update spotless_private.client_quote_terms set version=version where id=p_id returning * into t;
 if t.id is null then raise insufficient_privilege;end if;
 if t.state='withdrawn' then return spotless_private.quote_view(p_id);end if;
 if t.state='booked' then raise exception 'Use visit cancellation for a booked quote' using errcode='PT409';end if;
 update spotless_private.client_quote_terms set state='withdrawn',version=version+1 where id=p_id;
 update quotes set status='expired' where id=p_id;
 return spotless_private.quote_view(p_id);
end $$;
create function public.book_client_quote(p_id uuid,p_version integer) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare t spotless_private.client_quote_terms%rowtype;q quotes%rowtype;v_plan uuid;v_job uuid;v_day date;begin
 if auth.uid() is null or not is_admin() then raise insufficient_privilege;end if;
 t:=spotless_private.lock_quote(p_id);
 if t.state='booked' and t.booked_version=p_version then return spotless_private.quote_view(p_id);end if;
 if p_version is null or t.version<>p_version or t.state<>'published' or t.accepted is distinct from true
 or not exists(select 1 from spotless_private.client_quote_decisions where id=t.decision_id and actor=t.client_profile and quote_id=t.id and accepted)
 then raise exception 'Client approval changed. Review before booking.' using errcode='PT409';end if;
 select * into q from quotes where id=p_id;
 v_day:=(t.proposed_start at time zone 'America/Chicago')::date;
 if t.repeats then
  insert into recurring_plans(customer_id,property_id,service,freq,anchor_date,start_time,next_job_date,agreed_price_cents,estimated_minutes,notes,quote_extras)
   values(q.customer_id,q.property_id,q.service,q.freq,v_day,(t.proposed_start at time zone 'America/Chicago')::time,v_day,q.total_cents,q.estimated_minutes,t.work_notes,coalesce((select jsonb_agg(l) from jsonb_array_elements(t.lines) l where (l->>'isExtra')::boolean),'[]')) returning id into v_plan;
  select job_id into v_job from materialise_recurring_job(v_plan,v_day,t.proposed_start);
  if v_job is null then raise exception 'First occurrence was not created' using errcode='PT409';end if;
  update jobs set quote_id=p_id where id=v_job;
 else
  insert into jobs(customer_id,property_id,quote_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes,notes)
  values(q.customer_id,q.property_id,p_id,'scheduled',q.service,q.freq,t.proposed_start,q.total_cents,q.estimated_minutes,t.work_notes) returning id into v_job;
 end if;
 update spotless_private.client_quote_terms set state='booked',booked_version=p_version,version=version+1,job_id=v_job,plan_id=v_plan where id=p_id;
 return spotless_private.quote_view(p_id);
end $$;
-- An admin using the generic table API cannot rewrite client-reviewed terms or approval.
create function spotless_private.guard_managed_quote() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_managed boolean:=false;begin
 if current_user in ('authenticated','anon','service_role') then
  if TG_TABLE_NAME='quotes' then
   if TG_OP<>'INSERT' then v_managed:=old.client_managed;end if;
   if TG_OP<>'DELETE' then v_managed:=v_managed or new.client_managed;end if;
  else
   if TG_OP<>'INSERT' then select client_managed into v_managed from quotes where id=old.quote_id;end if;
   if TG_OP<>'DELETE' then v_managed:=coalesce(v_managed,false) or coalesce((select client_managed from quotes where id=new.quote_id),false);end if;
  end if;
  if v_managed then raise insufficient_privilege;end if;
 end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
create trigger managed_quote_guard before insert or update or delete on quotes for each row execute function spotless_private.guard_managed_quote();
create trigger managed_quote_line_guard before insert or update or delete on quote_line_items for each row execute function spotless_private.guard_managed_quote();
revoke all on function spotless_private.quote_home(uuid),spotless_private.quote_view(uuid),spotless_private.lock_quote(uuid),spotless_private.guard_managed_quote() from public,anon,authenticated,service_role;
revoke all on function read_client_quotes(uuid),prepare_client_quote(uuid,uuid,service_type,frequency,timestamptz,timestamptz,boolean,jsonb,text),publish_client_quote(uuid),decide_client_quote(uuid,uuid,integer,boolean),withdraw_client_quote(uuid),book_client_quote(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function read_client_quotes(uuid),prepare_client_quote(uuid,uuid,service_type,frequency,timestamptz,timestamptz,boolean,jsonb,text),publish_client_quote(uuid),decide_client_quote(uuid,uuid,integer,boolean),withdraw_client_quote(uuid),book_client_quote(uuid,integer) to authenticated;

-- Frequency edits retain the accepted flat extras; only the room rates change.
do $patch$
declare v_sql text;v_old text := 'h.bedrooms,h.bathrooms,h.half_baths,h.kitchens,h.living_rooms,h.utility_rooms) q;';begin
 select pg_get_functiondef('public.preview_recurring_edit(uuid,date,frequency,time without time zone,date,date,date)'::regprocedure) into v_sql;
 if strpos(v_sql,v_old)=0 then raise exception 'Recurring price function changed: review quote extras integration';end if;
 v_sql:=replace(v_sql,v_old,v_old||E'\n  v_price:=v_price+coalesce((select sum((l->>\'totalCents\')::integer) from jsonb_array_elements(p.quote_extras) l),0);\n  v_minutes:=v_minutes+coalesce((select sum((l->>\'cleanMinutes\')::integer) from jsonb_array_elements(p.quote_extras) l),0);');
 execute v_sql;
end $patch$;
