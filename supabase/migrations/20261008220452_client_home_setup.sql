-- A verified Client may save only their own home. Staff access and existing
-- office customer links are never derived from signup metadata or email alone.
create table spotless_private.client_home_setups (
  actor uuid not null references public.profiles(id),
  request_id uuid not null,
  input jsonb not null,
  property_id uuid not null references public.properties(id),
  created_at timestamptz not null default now(),
  primary key(actor, request_id)
);
alter table spotless_private.client_home_setups enable row level security;
revoke all on spotless_private.client_home_setups from public, anon, authenticated, service_role;
create table spotless_private.client_home_setup_locks (
  actor uuid primary key references public.profiles(id)
);
alter table spotless_private.client_home_setup_locks enable row level security;
revoke all on spotless_private.client_home_setup_locks from public, anon, authenticated, service_role;

create function public.save_my_home(p_id uuid, p_home jsonb, p_contact jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_email text; v_customer uuid;
  v_profile public.profiles%rowtype; v_property public.properties%rowtype;
  v_saved spotless_private.client_home_setups%rowtype;
  v_home jsonb; v_contact jsonb; v_input jsonb; k text; v_phone text;
begin
  -- Serialize retries and different requests for the same Client. The role is
  -- reread under this lock; a caller cannot pass a customer/profile id.
  select * into v_profile from public.profiles where id=v_actor for update;
  if not found or v_profile.role <> 'customer' then
    raise exception 'Client account required' using errcode='42501';
  end if;
  select email into v_email from auth.users where id=v_actor and email_confirmed_at is not null;
  if v_email is null or btrim(v_email)='' then
    raise exception 'confirmed email required' using errcode='42501';
  end if;
  if p_id is null or p_home is null or jsonb_typeof(p_home)<>'object'
    or not (p_home ?& array['street','city','state','zip','bedrooms','bathrooms','halfBaths','kitchens','livingRooms','utilityRooms'])
    or (p_home-array['street','city','state','zip','bedrooms','bathrooms','halfBaths','kitchens','livingRooms','utilityRooms'])<>'{}'::jsonb then
    raise exception 'home details required' using errcode='22023';
  end if;
  foreach k in array array['street','city','state','zip'] loop
    if jsonb_typeof(p_home->k)<>'string' or btrim(p_home->>k)=''
      or char_length(btrim(p_home->>k)) > case k when 'street' then 200 when 'city' then 100 when 'state' then 2 else 5 end
      or (p_home->>k) ~ '[[:cntrl:]]' then
      raise exception 'invalid address' using errcode='22023';
    end if;
  end loop;
  if upper(btrim(p_home->>'state')) !~ '^[A-Z]{2}$' or btrim(p_home->>'zip') !~ '^[0-9]{5}$' then
    raise exception 'invalid state or zip' using errcode='22023';
  end if;
  foreach k in array array['bedrooms','bathrooms','halfBaths','kitchens','livingRooms','utilityRooms'] loop
    if jsonb_typeof(p_home->k)<>'number' or (p_home->>k) !~ '^[0-8]$'
      or (k='halfBaths' and (p_home->>k)::integer>4) then
      raise exception 'invalid room count' using errcode='22023';
    end if;
  end loop;
  v_home := jsonb_build_object('street',btrim(p_home->>'street'),'city',btrim(p_home->>'city'),
    'state',upper(btrim(p_home->>'state')),'zip',btrim(p_home->>'zip'))
    || (p_home-array['street','city','state','zip']);
  if p_contact is not null then
    if jsonb_typeof(p_contact)<>'object' or not (p_contact ?& array['firstName','lastName','phone'])
      or (p_contact-array['firstName','lastName','phone'])<>'{}'::jsonb then
      raise exception 'invalid contact' using errcode='22023';
    end if;
    foreach k in array array['firstName','lastName','phone'] loop
      if jsonb_typeof(p_contact->k)<>'string' or btrim(p_contact->>k)=''
        or char_length(btrim(p_contact->>k))>case when k='phone' then 32 else 80 end
        or (p_contact->>k) ~ '[[:cntrl:]]' then raise exception 'invalid contact' using errcode='22023'; end if;
    end loop;
    v_phone:=btrim(p_contact->>'phone');
    if v_phone !~ '^[+()0-9 .-]{7,32}$' or char_length(regexp_replace(v_phone,'[^0-9]','','g'))<7 then
      raise exception 'invalid phone' using errcode='22023';
    end if;
    v_contact:=jsonb_build_object('firstName',btrim(p_contact->>'firstName'),'lastName',btrim(p_contact->>'lastName'),'phone',v_phone);
  end if;
  v_input:=jsonb_build_object('home',v_home,'contact',v_contact);
  -- Updating the per-Client lock version also aborts an older repeatable-read
  -- snapshot. A row lock alone would let that snapshot miss a newly saved home.
  insert into spotless_private.client_home_setup_locks(actor) values(v_actor)
    on conflict(actor) do update set actor=excluded.actor;
  select * into v_saved from spotless_private.client_home_setups where actor=v_actor and request_id=p_id;
  if found and v_saved.input is distinct from v_input then
    raise exception 'review changed' using errcode='PT409';
  end if;
  if v_saved.property_id is not null then
    select p.* into v_property from public.properties p join public.customers c on c.id=p.customer_id
      where p.id=v_saved.property_id and c.profile_id=v_actor;
    if not found then raise exception 'saved home unavailable' using errcode='PT409'; end if;
  else
    if (select count(*) from public.customers where profile_id=v_actor)>1 then
      raise exception 'Office connection required' using errcode='PHC01';
    end if;
    select id into v_customer from public.customers where profile_id=v_actor;
    if v_customer is null then
      -- Email equality alone is not permission to claim an imported account.
      if exists(select 1 from public.customers where lower(btrim(email))=lower(btrim(v_email))) then
        raise exception 'Office connection required' using errcode='PHC01';
      end if;
      if v_contact is null then raise exception 'contact details required' using errcode='22023'; end if;
      insert into public.customers(profile_id,first_name,last_name,email,phone,first_contact_date)
        values(v_actor,v_contact->>'firstName',v_contact->>'lastName',v_email,v_contact->>'phone',current_date)
        returning id into v_customer;
    end if;
    select * into v_property from public.properties where customer_id=v_customer
      and lower(regexp_replace(btrim(street),'\s+',' ','g'))=lower(regexp_replace(v_home->>'street','\s+',' ','g'))
      and lower(regexp_replace(btrim(city),'\s+',' ','g'))=lower(regexp_replace(v_home->>'city','\s+',' ','g'))
      and upper(btrim(state))=v_home->>'state' and btrim(zip)=v_home->>'zip'
      order by created_at,id limit 1;
    if not found then
      insert into public.properties(customer_id,street,city,state,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms,size_verified_source)
        values(v_customer,v_home->>'street',v_home->>'city',v_home->>'state',v_home->>'zip',
          (v_home->>'bedrooms')::integer,(v_home->>'bathrooms')::integer,(v_home->>'halfBaths')::integer,
          (v_home->>'kitchens')::integer,(v_home->>'livingRooms')::integer,(v_home->>'utilityRooms')::integer,'customer')
        returning * into v_property;
    end if;
    insert into spotless_private.client_home_setups(actor,request_id,input,property_id) values(v_actor,p_id,v_input,v_property.id);
  end if;
  if jsonb_build_object('street',v_property.street,'city',v_property.city,'state',v_property.state,'zip',v_property.zip,
    'bedrooms',v_property.bedrooms,'bathrooms',v_property.bathrooms,'halfBaths',v_property.half_baths,
    'kitchens',v_property.kitchens,'livingRooms',v_property.living_rooms,'utilityRooms',v_property.utility_rooms) is distinct from v_home then
    raise exception 'saved home changed' using errcode='PT409';
  end if;
  return jsonb_build_object('id',v_property.id,'customerId',v_property.customer_id,'home',v_home);
end $$;
revoke all on function public.save_my_home(uuid,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_my_home(uuid,jsonb,jsonb) to authenticated;
