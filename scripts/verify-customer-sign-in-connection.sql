-- Disposable verification database only. Everything rolls back.
--
-- Management connecting a customer's confirmed sign-in to their existing
-- (typically imported) customer record: every refusal the database makes on
-- its own, the audit row, idempotence, the one-sign-in-one-customer rule, and
-- the outcome that matters, which is that the customer stops being told
-- "Office connection required" and starts seeing their own record.
begin;
alter table auth.users add column if not exists email_confirmed_at timestamptz;
grant usage on schema public, auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant select on profiles, customers, properties, jobs to authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'office@example.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'kim@example.test', now()),
  ('e1000000-0000-4000-8000-000000000003', 'unconfirmed@example.test', null),
  ('e1000000-0000-4000-8000-000000000004', 'cleaner@example.test', now()),
  ('e1000000-0000-4000-8000-000000000005', 'shared@example.test', now()),
  ('e1000000-0000-4000-8000-000000000006', 'already@example.test', now()),
  ('e1000000-0000-4000-8000-000000000007', 'SHARED@example.test', now());
update profiles set role = 'admin' where id = 'e1000000-0000-4000-8000-000000000001';
update profiles set role = 'cleaner' where id = 'e1000000-0000-4000-8000-000000000004';

insert into customers (id, first_name, last_name, email, hcp_customer_id) values
  -- Case and spacing differ from the sign-in on purpose.
  ('e2000000-0000-4000-8000-000000000001', 'Kim', 'Imported', ' KIM@example.test ', 'verify-hcp-1'),
  ('e2000000-0000-4000-8000-000000000002', 'Una', 'Confirmed', 'unconfirmed@example.test', 'verify-hcp-2'),
  ('e2000000-0000-4000-8000-000000000003', 'Cleo', 'Cleaner', 'cleaner@example.test', 'verify-hcp-3'),
  ('e2000000-0000-4000-8000-000000000004', 'Sam', 'SharedOne', 'shared@example.test', 'verify-hcp-4'),
  ('e2000000-0000-4000-8000-000000000005', 'Sid', 'SharedTwo', 'shared@example.test', 'verify-hcp-5'),
  ('e2000000-0000-4000-8000-000000000006', 'Nora', 'NoEmail', null, 'verify-hcp-6'),
  ('e2000000-0000-4000-8000-000000000008', 'Ada', 'Imported', 'already@example.test', 'verify-hcp-8');
-- A sign-in that already has its own customer record (signed up as a new customer).
insert into customers (id, first_name, last_name, email, profile_id) values
  ('e2000000-0000-4000-8000-000000000007', 'Ada', 'SelfServe', 'already@example.test', 'e1000000-0000-4000-8000-000000000006');

do $$
declare
  admin constant uuid := 'e1000000-0000-4000-8000-000000000001';
  kim_in constant uuid := 'e1000000-0000-4000-8000-000000000002';
  kim constant uuid := 'e2000000-0000-4000-8000-000000000001';
  s jsonb;
  r jsonb;
begin
  -- Only the server may call these.
  if has_function_privilege('anon', 'public.connect_customer_sign_in(uuid,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.connect_customer_sign_in(uuid,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.customer_sign_in_status(uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.connect_customer_sign_in(uuid,uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.customer_sign_in_status(uuid,uuid)', 'execute') then
    raise exception 'Sign-in connection functions have the wrong privileges';
  end if;
  if has_table_privilege('authenticated', 'spotless_private.customer_sign_in_connections', 'select') then
    raise exception 'Connection audit exposed';
  end if;

  -- The actor must be Management.
  begin
    perform connect_customer_sign_in(kim, kim_in, kim_in);
    raise exception 'A customer connected a sign-in';
  exception when insufficient_privilege then null;
  end;
  begin
    perform customer_sign_in_status(kim, 'e1000000-0000-4000-8000-000000000004');
    raise exception 'A cleaner read sign-in status';
  exception when insufficient_privilege then null;
  end;

  -- What the panel offers.
  s := customer_sign_in_status(kim, admin);
  if s->'connected' <> 'null'::jsonb or jsonb_array_length(s->'candidates') <> 1
     or s->'candidates'->0->>'profileId' <> kim_in::text or (s->>'customersWithThisEmail')::int <> 1 then
    raise exception 'Kim''s candidates wrong: %', s;
  end if;
  if jsonb_array_length(customer_sign_in_status('e2000000-0000-4000-8000-000000000002', admin)->'candidates') <> 0 then
    raise exception 'Unconfirmed sign-in offered';
  end if;
  if jsonb_array_length(customer_sign_in_status('e2000000-0000-4000-8000-000000000003', admin)->'candidates') <> 0 then
    raise exception 'Cleaner sign-in offered to a customer';
  end if;
  if jsonb_array_length(customer_sign_in_status('e2000000-0000-4000-8000-000000000008', admin)->'candidates') <> 0 then
    raise exception 'Sign-in already in use offered';
  end if;
  s := customer_sign_in_status('e2000000-0000-4000-8000-000000000004', admin);
  if jsonb_array_length(s->'candidates') <> 2 or (s->>'customersWithThisEmail')::int <> 2 then
    raise exception 'Shared email not flagged: %', s;
  end if;
  s := customer_sign_in_status('e2000000-0000-4000-8000-000000000006', admin);
  if jsonb_array_length(s->'candidates') <> 0 or (s->>'customersWithThisEmail')::int <> 0 then
    raise exception 'Customer with no email offered a sign-in: %', s;
  end if;
  if customer_sign_in_status(gen_random_uuid(), admin)->>'found' <> 'false' then
    raise exception 'Unknown customer reported as found';
  end if;

  -- Every refusal, and none of them connects anything.
  if connect_customer_sign_in('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', admin)->>'reason' <> 'email_not_confirmed'
     or connect_customer_sign_in('e2000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000004', admin)->>'reason' <> 'not_a_customer_sign_in'
     or connect_customer_sign_in('e2000000-0000-4000-8000-000000000004', kim_in, admin)->>'reason' <> 'email_mismatch'
     or connect_customer_sign_in('e2000000-0000-4000-8000-000000000006', kim_in, admin)->>'reason' <> 'email_mismatch'
     or connect_customer_sign_in('e2000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000006', admin)->>'reason' <> 'sign_in_in_use'
     or connect_customer_sign_in(kim, gen_random_uuid(), admin)->>'reason' <> 'no_sign_in'
     or connect_customer_sign_in(gen_random_uuid(), kim_in, admin)->>'reason' <> 'no_customer' then
    raise exception 'A refusal did not refuse as expected';
  end if;
  if exists (select 1 from customers where hcp_customer_id like 'verify-hcp-%' and profile_id is not null)
     or exists (select 1 from spotless_private.customer_sign_in_connections) then
    raise exception 'A refused connection changed something';
  end if;
end $$;

-- Before connection: the customer is refused, exactly as today.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$ begin
  perform save_my_home('e3000000-0000-4000-8000-000000000001',
    '{"street":"7 Verify Ln","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":1,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":0}',
    '{"firstName":"Kim","lastName":"Imported","phone":"469-555-0102"}');
  raise exception 'Imported account claimed by email alone';
exception when sqlstate 'PHC01' then null;
end $$;
reset role;

do $$
declare
  admin constant uuid := 'e1000000-0000-4000-8000-000000000001';
  kim_in constant uuid := 'e1000000-0000-4000-8000-000000000002';
  kim constant uuid := 'e2000000-0000-4000-8000-000000000001';
  r jsonb;
  s jsonb;
begin
  r := connect_customer_sign_in(kim, kim_in, admin);
  if r->>'connected' <> 'true' or r->>'alreadyConnected' <> 'false' then raise exception 'Connection failed: %', r; end if;
  if (select profile_id from customers where id = kim) <> kim_in then raise exception 'Customer not connected'; end if;
  if (select count(*) from spotless_private.customer_sign_in_connections
       where customer_id = kim and profile_id = kim_in and connected_by = admin and email = 'kim@example.test') <> 1 then
    raise exception 'Connection not audited';
  end if;

  s := customer_sign_in_status(kim, admin);
  if s->'connected'->>'profileId' <> kim_in::text or s->'connected'->>'email' <> 'kim@example.test'
     or s->'connected'->>'connectedAt' is null or jsonb_array_length(s->'candidates') <> 0 then
    raise exception 'Status after connection wrong: %', s;
  end if;

  -- Repeating it is harmless and is not a second connection.
  r := connect_customer_sign_in(kim, kim_in, admin);
  if r->>'alreadyConnected' <> 'true' then raise exception 'Repeat was not recognised: %', r; end if;
  if (select count(*) from spotless_private.customer_sign_in_connections) <> 1 then raise exception 'Repeat audited twice'; end if;

  -- A connected record takes no other sign-in, and a sign-in serves one customer.
  r := connect_customer_sign_in('e2000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000005', admin);
  if r->>'connected' <> 'true' then raise exception 'Shared-email customer not connected: %', r; end if;
  if connect_customer_sign_in('e2000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000007', admin)->>'reason' <> 'customer_has_sign_in'
     or connect_customer_sign_in('e2000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000005', admin)->>'reason' <> 'sign_in_in_use' then
    raise exception 'A connected record or sign-in was connected again';
  end if;
  begin
    insert into customers (first_name, last_name, profile_id) values ('Second', 'Record', kim_in);
    raise exception 'One sign-in held two customers';
  exception when unique_violation then null;
  end;
end $$;

-- After connection: the same customer sees their own record and can add a home.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  if current_customer_id() <> 'e2000000-0000-4000-8000-000000000001' then raise exception 'Customer does not resolve to their record'; end if;
  r := save_my_home('e3000000-0000-4000-8000-000000000002',
    '{"street":"7 Verify Ln","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":1,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":0}',
    null);
  if (r->>'customerId')::uuid <> 'e2000000-0000-4000-8000-000000000001' then raise exception 'Home saved to the wrong customer: %', r; end if;
end $$;
reset role;

do $$ begin
  if (select count(*) from customers where profile_id = 'e1000000-0000-4000-8000-000000000002') <> 1 then
    raise exception 'Adding a home created a second customer';
  end if;
end $$;

rollback;
\echo '  customer sign-in connection verified'
