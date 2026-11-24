-- Management connects a customer's confirmed sign-in to their existing record.
--
-- An imported customer who signs up is refused by save_my_home ("Office
-- connection required"): email equality alone is not permission to claim an
-- imported account, because anyone can sign up with anyone's email. Until now
-- the office had no way to make that connection except editing the database.
--
-- These functions make it an office action, with the same rule the refusal
-- encodes: a person confirms who the customer is, and the database still
-- insists on everything it can check itself. The sign-in must be a customer's,
-- its email confirmed, and equal to the email on the customer record; the
-- record must not already have a sign-in, and the sign-in must not already
-- belong to anyone. Service role only: the route checks the Management role,
-- and both functions recheck the saved role of the actor they are given.

-- One sign-in, one customer. current_customer_id() and every customer RLS
-- policy already assume it; this makes it a rule rather than a hope.
create unique index if not exists customers_one_per_sign_in
  on public.customers (profile_id) where profile_id is not null;

create table spotless_private.customer_sign_in_connections (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  email         text not null,
  connected_by  uuid not null references public.profiles(id),
  connected_at  timestamptz not null default clock_timestamp()
);
alter table spotless_private.customer_sign_in_connections enable row level security;
revoke all on spotless_private.customer_sign_in_connections from public, anon, authenticated, service_role;

create function public.customer_sign_in_status(p_customer uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  c public.customers%rowtype;
  v_email text;
  v_connected jsonb;
  v_candidates jsonb;
begin
  if p_customer is null or p_actor is null then raise invalid_parameter_value; end if;
  if not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
    raise insufficient_privilege using message = 'Management access is required.';
  end if;

  select * into c from public.customers where id = p_customer;
  if c.id is null then return jsonb_build_object('found', false); end if;
  v_email := nullif(lower(btrim(c.email)), '');

  if c.profile_id is not null then
    select jsonb_build_object(
             'profileId', c.profile_id,
             'email', (select u.email from auth.users u where u.id = c.profile_id),
             'connectedAt', (select max(x.connected_at) from spotless_private.customer_sign_in_connections x
                             where x.customer_id = c.id and x.profile_id = c.profile_id))
      into v_connected;
  end if;

  -- Only sign-ins that could actually be connected: a customer's, confirmed,
  -- the record's own email, and not already anyone's.
  select coalesce(jsonb_agg(jsonb_build_object(
           'profileId', u.id,
           'email', u.email,
           'confirmedAt', u.email_confirmed_at,
           'signedUpAt', u.created_at) order by u.created_at), '[]'::jsonb)
    into v_candidates
    from auth.users u
    join public.profiles p on p.id = u.id and p.role = 'customer'
   where c.profile_id is null
     and v_email is not null
     and u.email_confirmed_at is not null
     and lower(btrim(u.email)) = v_email
     and not exists (select 1 from public.customers k where k.profile_id = u.id);

  return jsonb_build_object(
    'found', true,
    'customerEmail', c.email,
    'connected', v_connected,
    'candidates', v_candidates,
    -- Shared placeholder emails are common in the Housecall Pro import; the
    -- office should know a sign-in's email names more than one customer.
    'customersWithThisEmail',
      case when v_email is null then 0
           else (select count(*) from public.customers k where lower(btrim(k.email)) = v_email) end);
end $$;

create function public.connect_customer_sign_in(p_customer uuid, p_profile uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  c public.customers%rowtype;
  v_role text;
  v_email text;
begin
  if p_customer is null or p_profile is null or p_actor is null then raise invalid_parameter_value; end if;
  perform 1 from public.profiles where id = p_actor and role = 'admin' for share;
  if not found then raise insufficient_privilege using message = 'Management access is required.'; end if;

  -- Sign-in first, then customer: two offices connecting one sign-in to two
  -- customers queue on the sign-in, and the second sees it already in use.
  select role::text into v_role from public.profiles where id = p_profile for update;
  if v_role is null then return jsonb_build_object('connected', false, 'reason', 'no_sign_in'); end if;
  if v_role <> 'customer' then return jsonb_build_object('connected', false, 'reason', 'not_a_customer_sign_in'); end if;

  select * into c from public.customers where id = p_customer for update;
  if c.id is null then return jsonb_build_object('connected', false, 'reason', 'no_customer'); end if;
  if c.profile_id = p_profile then
    return jsonb_build_object('connected', true, 'alreadyConnected', true, 'customerId', c.id, 'profileId', p_profile);
  end if;
  if c.profile_id is not null then return jsonb_build_object('connected', false, 'reason', 'customer_has_sign_in'); end if;
  if exists (select 1 from public.customers where profile_id = p_profile) then
    return jsonb_build_object('connected', false, 'reason', 'sign_in_in_use');
  end if;

  select email into v_email from auth.users where id = p_profile and email_confirmed_at is not null;
  if v_email is null then return jsonb_build_object('connected', false, 'reason', 'email_not_confirmed'); end if;
  if c.email is null or lower(btrim(c.email)) <> lower(btrim(v_email)) then
    return jsonb_build_object('connected', false, 'reason', 'email_mismatch');
  end if;

  begin
    update public.customers set profile_id = p_profile where id = c.id;
  exception when unique_violation then
    return jsonb_build_object('connected', false, 'reason', 'sign_in_in_use');
  end;
  insert into spotless_private.customer_sign_in_connections (customer_id, profile_id, email, connected_by)
    values (c.id, p_profile, v_email, p_actor);

  return jsonb_build_object('connected', true, 'alreadyConnected', false, 'customerId', c.id, 'profileId', p_profile);
end $$;

revoke all on function public.customer_sign_in_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.connect_customer_sign_in(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.customer_sign_in_status(uuid, uuid) to service_role;
grant execute on function public.connect_customer_sign_in(uuid, uuid, uuid) to service_role;
