-- Run only in the throwaway database created by verify-migrations.sh.
--
-- Extended past the four routines Codex's 0007 covered: every privileged
-- routine added since (cards in 0009, webhook leases in 0010, refunds and
-- credits in 0011) is server-side too, and a new one that quietly forgot to
-- revoke would be a client-writable money path. The list below is the
-- enumeration, and the service_role block at the bottom is the other half —
-- that locking the client out did not lock the server out as well.
-- Use ordinary roles and deliberately broad table grants to test RLS, not
-- just a superuser whose queries bypass the policies. Roll fixtures back.
begin;
grant usage on schema public, auth to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema verify_access;
grant usage on schema verify_access to anon, authenticated, service_role;
create function verify_access.expect_billing_denied() returns void
language plpgsql as $$
declare statement text;
begin
  foreach statement in array array[
    $q$select record_payment('10000000-0000-0000-0000-000000000001', 100)$q$,
    $q$select record_refund('pi_access_test', 100)$q$,
    $q$select record_invoice_credit('10000000-0000-0000-0000-000000000001', 100)$q$,
    $q$select settle_refund('re_access_test', 'succeeded')$q$,
    $q$select save_payment_method('30000000-0000-0000-0000-000000000001', 'pm_access_test')$q$,
    $q$select detach_payment_method('pm_access_test')$q$,
    $q$select claim_stripe_event('evt_access_test', 't', '{}'::jsonb, gen_random_uuid())$q$,
    $q$select finish_stripe_event('evt_access_test', gen_random_uuid(), 'applied')$q$,
    $q$select release_stripe_event('evt_access_test', gen_random_uuid())$q$,
    $q$select business_today()$q$,
    $q$select begin_payment_operation('10000000-0000-0000-0000-000000000001',
                                      'checkout', 'access-test', 100)$q$,
    $q$select attach_payment_operation('access-test', 'checkout_session', 'cs_x')$q$,
    $q$select resolve_payment_operation('access-test', 'failed')$q$,
    $q$select settle_payment_operation_by_ref('10000000-0000-0000-0000-000000000001', 'cs_x')$q$,
    $q$select record_autocharge_failure('10000000-0000-0000-0000-000000000001', 'test')$q$,
    $q$select resettle_invoice('10000000-0000-0000-0000-000000000001')$q$
  ] loop
    begin
      execute statement;
      raise exception 'privileged billing call was allowed for %: %', current_user, statement;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- Client-supplied role requests must not grant staff access at signup.
insert into auth.users (id, email, raw_user_meta_data) values
  ('20000000-0000-0000-0000-000000000001', 'customer-a@example.invalid', '{}'),
  ('20000000-0000-0000-0000-000000000002', 'customer-b@example.invalid', '{}'),
  ('20000000-0000-0000-0000-000000000003', 'cleaner@example.invalid', '{"role":"cleaner"}'),
  ('20000000-0000-0000-0000-000000000004', 'admin@example.invalid', '{"role":"admin"}');
do $$
begin
  if exists (select 1 from profiles where id in (
    '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004'
  ) and role <> 'customer') then
    raise exception 'signup metadata granted a staff role';
  end if;
end $$;

-- Deliberate, privileged staff provisioning for the rest of the tests.
update profiles set role = 'cleaner' where id = '20000000-0000-0000-0000-000000000003';
update profiles set role = 'admin' where id = '20000000-0000-0000-0000-000000000004';
insert into customers (id, profile_id, first_name, last_name) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Test', 'A'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Test', 'B');
insert into properties (id, customer_id, street, city, zip) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Test A', 'Test', '75024'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Test B', 'Test', '75024');
insert into jobs (id, customer_id, property_id, service, freq, price_cents,
                  estimated_clean_minutes, dispatch_channel) values
  ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001', 'standard', 'one_time', 17000, 120, 'direct_assign'),
  ('50000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002',
   '40000000-0000-0000-0000-000000000002', 'standard', 'one_time', 17000, 120, 'open_board');
insert into cleaners (id, profile_id, full_name, type, status, rating, background_check_cleared)
values ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003',
        'Test Cleaner', 'contractor_1099', 'active', 4.9, true);
insert into offers (id, job_id, cleaner_id, channel, hourly_rate_cents,
                    payout_cents, payout_pct, estimated_minutes, expires_at)
values ('70000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002',
        '60000000-0000-0000-0000-000000000001', 'open_board', 2500, 5000, 0.2941, 120,
        now() + interval '1 hour');
insert into invoices (id, customer_id, status, subtotal_cents, total_cents)
values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
        'sent', 17000, 17000),
       ('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002',
        'sent', 17000, 17000);

-- One of each new row per customer, so "sees their own" and "does not see
-- the other's" are both real assertions rather than half of one.
insert into invoice_adjustments (id, invoice_id, amount_cents, reason) values
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   2000, 'goodwill'),
  ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
   2000, 'goodwill');
-- Inserted directly for the fixed ids the visibility checks need, so the
-- invoice's own total has to be kept in step by hand; record_invoice_credit
-- is what does both in the application.
update invoices set credit_cents = 2000
where id in ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002');
insert into payment_operations (id, invoice_id, channel, idempotency_key, amount_cents, expires_at)
values
  ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'checkout', 'verify-access-a', 17000, now() + interval '1 hour'),
  ('90000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
   'checkout', 'verify-access-b', 17000, now() + interval '1 hour');

set local role anon;
select verify_access.expect_billing_denied();
do $$
begin
  if exists (select 1 from jobs where id = '50000000-0000-0000-0000-000000000002') then
    raise exception 'anonymous user saw an open-board job';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select verify_access.expect_billing_denied();
do $$
begin
  if not exists (select 1 from jobs where id = '50000000-0000-0000-0000-000000000001') then
    raise exception 'customer cannot see their own job';
  end if;
  if exists (select 1 from jobs where id = '50000000-0000-0000-0000-000000000002') then
    raise exception 'customer saw another customer''s open-board job';
  end if;

  -- The tables added since 0007 need the same treatment. A credit explains
  -- why an invoice reads as settled, and a collection attempt explains why
  -- the Pay button is refusing — both are the customer's own business and
  -- nobody else's.
  if not exists (select 1 from invoice_adjustments
                 where id = '80000000-0000-0000-0000-000000000001') then
    raise exception 'customer cannot see the credit on their own invoice';
  end if;
  if exists (select 1 from invoice_adjustments
             where id = '80000000-0000-0000-0000-000000000002') then
    raise exception 'customer saw a credit on another customer''s invoice';
  end if;
  if not exists (select 1 from payment_operations
                 where id = '90000000-0000-0000-0000-000000000001') then
    raise exception 'customer cannot see their own collection attempt';
  end if;
  if exists (select 1 from payment_operations
             where id = '90000000-0000-0000-0000-000000000002') then
    raise exception 'customer saw another customer''s collection attempt';
  end if;

  -- And writing them is a server act, never a client one: a customer who
  -- could insert a credit could settle their own invoice for nothing.
  begin
    insert into invoice_adjustments (invoice_id, amount_cents)
    values ('10000000-0000-0000-0000-000000000001', 17000);
    raise exception 'customer wrote a credit against their own invoice';
  exception when insufficient_privilege then null; end;
  begin
    update payment_operations set state = 'failed'
    where id = '90000000-0000-0000-0000-000000000001';
    if found then raise exception 'customer resolved their own collection attempt'; end if;
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', true);
select verify_access.expect_billing_denied();
do $$
declare changed integer;
begin
  if not exists (select 1 from jobs where id = '50000000-0000-0000-0000-000000000002') then
    raise exception 'provisioned cleaner cannot see open-board work';
  end if;
  if not exists (select 1 from offers where id = '70000000-0000-0000-0000-000000000001') then
    raise exception 'cleaner cannot see their offer';
  end if;
  update offers set payout_cents = 99999, status = 'accepted'
    where id = '70000000-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'cleaner changed their offer directly'; end if;
  if exists (select 1 from offers where id = '70000000-0000-0000-0000-000000000001'
             and (payout_cents <> 5000 or status <> 'sent')) then
    raise exception 'cleaner offer changed despite the write restriction';
  end if;
end $$;

-- Even an admin browser session uses the authenticated role. These privileged
-- routines must go through authenticated server routes using service_role.
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000004', true);
select verify_access.expect_billing_denied();
do $$
declare changed integer;
begin
  update offers set payout_cents = 5100
    where id = '70000000-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'admin cannot update an offer'; end if;
end $$;
reset role;

-- The server still has all four required permissions and can actually record
-- a payment. This guards against a migration that disables billing entirely.
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare signature text; payment_id uuid; v_owner uuid := gen_random_uuid();
        v_outcome text;
begin
  foreach signature in array array[
    'record_payment(uuid,integer,integer,text,text,text,boolean,text)',
    'record_refund(text,integer,text,uuid,text,refund_kind,refund_status)',
    'record_invoice_credit(uuid,integer,text,uuid,uuid)',
    'settle_refund(text,refund_status)',
    'save_payment_method(uuid,text,text,text,integer,integer)',
    'detach_payment_method(text)',
    'claim_stripe_event(text,text,jsonb,uuid,integer)',
    'finish_stripe_event(text,uuid,text,text)',
    'release_stripe_event(text,uuid,text)',
    'business_today()',
    'begin_payment_operation(uuid,payment_operation_channel,text,integer,integer)',
    'attach_payment_operation(text,text,text,text,timestamptz)',
    'resolve_payment_operation(text,payment_operation_state,text)',
    'settle_payment_operation_by_ref(uuid,text)',
    'record_autocharge_failure(uuid,text,timestamptz)',
    'resettle_invoice(uuid)'
  ] loop
    if not has_function_privilege(current_user, signature, 'execute') then
      raise exception 'server lost execution privilege on %', signature;
    end if;
  end loop;
  payment_id := record_payment('10000000-0000-0000-0000-000000000001', 17000,
                               0, 'pi_access_test');
  if payment_id is null or not exists (
    select 1 from invoices where id = '10000000-0000-0000-0000-000000000001'
      and amount_paid_cents = 17000 and balance_cents = -2000
  ) then raise exception 'server payment did not settle the invoice'; end if;

  -- Everything added since 0007 has to work for the server as well as be
  -- shut to everyone else. Locking clients out of a routine the server then
  -- cannot call is the same outage by a different route.
  if record_refund('pi_access_test', 5000, 're_access_test', null, 'goodwill test',
                   'goodwill') is null then
    raise exception 'server could not record a refund';
  end if;
  if not exists (select 1 from invoices where id = '10000000-0000-0000-0000-000000000001'
                 and refunded_cents = 5000 and credit_cents = 7000) then
    raise exception 'the server refund did not raise its matching credit';
  end if;

  if save_payment_method('30000000-0000-0000-0000-000000000001', 'pm_access_ok',
                         'visa', '4242', 1, 2030) is not true then
    raise exception 'server could not save a first card as the default';
  end if;
  if detach_payment_method('pm_access_ok') is not null then
    raise exception 'detaching the only card reported a successor';
  end if;

  if claim_stripe_event('evt_access_ok', 'payment_intent.succeeded', '{}'::jsonb,
                        v_owner) <> 'claimed' then
    raise exception 'server could not claim a webhook event';
  end if;
  if not finish_stripe_event('evt_access_ok', v_owner, 'applied') then
    raise exception 'server could not finish the event it claimed';
  end if;

  select outcome into v_outcome
  from begin_payment_operation('10000000-0000-0000-0000-000000000002', 'checkout',
                               'verify-access-b', 17000);
  if v_outcome <> 'existing' then
    raise exception 'server saw % for an attempt already open, want existing', v_outcome;
  end if;
end $$;
reset role;

rollback;
