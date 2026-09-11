#!/usr/bin/env bash
# Applies every migration to a throwaway database and checks quote_price()
# against the published pricelist totals. Requires Postgres — a local
# cluster, or a service container reachable through the PG* environment.
set -euo pipefail

DB="${1:-spotless_verify}"
PSQL="psql -v ON_ERROR_STOP=1 -q"

# Two ways to reach a superuser. On a developer machine Postgres runs locally
# and the way in is the `postgres` system account. In CI it is a service
# container over TCP, where no such account exists to sudo to — so PGHOST being
# set means "the PG* environment already points at a superuser, just run psql".
if [ -n "${PGHOST:-}" ]; then
  as_super() { "$@"; }
else
  as_super() { sudo -u postgres "$@"; }
fi

as_super dropdb --if-exists "$DB"
as_super createdb "$DB"

# Supabase provides auth.uid() at runtime. Stub it so RLS policies compile
# locally; the real thing is supplied by Supabase in every deployed
# environment. This stub exists only for verification and is not a migration.
as_super $PSQL -d "$DB" <<'SQL'
create schema if not exists auth;

-- Exercise access controls with Supabase-like client and server roles. These
-- are cluster roles, so a second verification run must reuse them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- Model both PUBLIC's default EXECUTE and explicit client-role defaults.
-- Migration 0007 must revoke both sources of privilege.
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- Minimal stand-in for Supabase's auth.users, enough for the FK and the signup
-- trigger in 0004 to be exercised. The real table has many more columns.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$f$;
SQL

for f in supabase/migrations/*.sql; do
  echo "  applying $(basename "$f")"
  as_super $PSQL -d "$DB" -f "$f"
done
echo "  all migrations applied"

# --- golden check: quote_price() must reproduce the published pricelist ------
echo "  checking quote_price() against the 9 Aug 2026 pricelist"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  r record; v_actual integer; v_fail integer := 0; v_ok integer := 0;
begin
  for r in select * from (values
    (1,1,15700,25800,32400),(2,1,17700,29200,36300),(2,2,19900,32800,40800),
    (3,2,21900,36200,44700),(3,3,24100,39800,49200),(4,2,23900,39600,48600),
    (4,3,26100,43200,53100),(5,3,28100,46600,57000),(6,4,32300,53600,65400)
  ) as t(beds,baths,std,deep,mio) loop
    select total_cents into v_actual from quote_price('standard','one_time',r.beds,r.baths);
    if v_actual = r.std then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'standard %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.std; end if;
    select total_cents into v_actual from quote_price('deep','one_time',r.beds,r.baths);
    if v_actual = r.deep then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'deep %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.deep; end if;
    select total_cents into v_actual from quote_price('move_in_out','one_time',r.beds,r.baths);
    if v_actual = r.mio then v_ok := v_ok+1; else v_fail := v_fail+1;
      raise warning 'move_in_out %bd/%ba: got %, want %', r.beds,r.baths,v_actual,r.mio; end if;
  end loop;

  -- a service/frequency pair that does not exist must raise, not quote $0
  begin
    perform * from quote_price('move_in_out','weekly',3,2);
    v_fail := v_fail + 1;
    raise warning 'move_in_out/weekly returned a quote instead of raising';
  exception when sqlstate 'P0001' then v_ok := v_ok + 1;
  end;

  raise notice '% passed, % failed', v_ok, v_fail;
  if v_fail > 0 then raise exception '% price book assertions failed', v_fail; end if;
end $$;
SQL
echo "  price book verified"

# --- billing invariants (0006) ----------------------------------------------
# The money rules that lib/billing/amounts.ts assumes. If these and the
# TypeScript ever disagree, the database is right and the tests are wrong.
echo "  checking billing invariants"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_bal integer; v_fail integer := 0;
begin
  insert into customers (first_name, last_name) values ('Verify','Only')
    returning id into v_cust;
  insert into invoices (customer_id, subtotal_cents, tip_cents, total_cents)
    values (v_cust, 17000, 2000, 19000) returning id into v_inv;

  -- balance_cents = total - paid + refunded, generated, never hand-written
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> 19000 then v_fail := v_fail+1;
    raise warning 'unpaid balance: got %, want 19000', v_bal; end if;

  update invoices set amount_paid_cents = 19000 where id = v_inv;
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'paid balance: got %, want 0', v_bal; end if;

  -- a refund RESTORES balance rather than shrinking the invoice
  update invoices set refunded_cents = 19000 where id = v_inv;
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> 19000 then v_fail := v_fail+1;
    raise warning 'refunded balance: got %, want 19000', v_bal; end if;

  begin
    update invoices set refunded_cents = 19001 where id = v_inv;
    v_fail := v_fail+1; raise warning 'refund beyond captured was accepted';
  exception when check_violation then null; end;

  -- autopay cannot be enabled without recorded consent
  begin
    update customers set autopay_enabled = true where id = v_cust;
    v_fail := v_fail+1; raise warning 'autopay without consent was accepted';
  exception when check_violation then null; end;
  update customers set autopay_enabled = true, autopay_authorized_at = now()
    where id = v_cust;

  -- one default card per customer, enforced against the click race
  insert into payment_methods (customer_id, stripe_payment_method_id, last4, is_default)
    values (v_cust, 'pm_verify_a', '4242', true);
  begin
    insert into payment_methods (customer_id, stripe_payment_method_id, last4, is_default)
      values (v_cust, 'pm_verify_b', '1881', true);
    v_fail := v_fail+1; raise warning 'second default card was accepted';
  exception when unique_violation then null; end;

  -- the webhook dedupe guarantee
  insert into stripe_events (id, type) values ('evt_verify', 'checkout.session.completed');
  begin
    insert into stripe_events (id, type) values ('evt_verify', 'checkout.session.completed');
    v_fail := v_fail+1; raise warning 'duplicate webhook event was accepted';
  exception when unique_violation then null; end;

  if v_fail > 0 then raise exception '% billing assertions failed', v_fail; end if;
  raise notice 'billing invariants passed';
end $$;
SQL
echo "  billing verified"

# --- money mutations (0006) --------------------------------------------------
# record_payment / record_refund / record_autocharge_failure are the only paths
# that move money, and both of their callers can fire twice for the same event.
# These assertions are the proof that the second call is a no-op.
echo "  checking money mutations"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_pay uuid; v_again uuid;
  v_paid integer; v_tip integer; v_total integer; v_bal integer; v_credit integer;
  v_status invoice_status; v_attempts integer; v_fail integer := 0;
begin
  insert into customers (first_name, last_name) values ('Money','Path')
    returning id into v_cust;
  insert into invoices (customer_id, status, subtotal_cents, total_cents, due_on)
    values (v_cust, 'sent', 17000, 17000, current_date - 1) returning id into v_inv;

  -- a capture with a tip settles the invoice and folds the tip into the total
  v_pay := record_payment(v_inv, 19000, 2000, 'pi_money_1', 'ch_money_1', null, false, 'card');
  if v_pay is null then v_fail := v_fail+1; raise warning 'first capture returned null'; end if;

  select amount_paid_cents, tip_cents, total_cents, balance_cents, status
    into v_paid, v_tip, v_total, v_bal, v_status from invoices where id = v_inv;
  if v_paid <> 19000 then v_fail := v_fail+1; raise warning 'paid: got %, want 19000', v_paid; end if;
  if v_tip  <> 2000  then v_fail := v_fail+1; raise warning 'tip: got %, want 2000', v_tip; end if;
  if v_total<> 19000 then v_fail := v_fail+1; raise warning 'total: got %, want 19000', v_total; end if;
  if v_bal  <> 0     then v_fail := v_fail+1; raise warning 'balance: got %, want 0', v_bal; end if;
  if v_status <> 'paid' then v_fail := v_fail+1; raise warning 'status: got %, want paid', v_status; end if;

  -- THE REPLAY: the same payment_intent must not be applied twice
  v_again := record_payment(v_inv, 19000, 2000, 'pi_money_1', 'ch_money_1', null, false, 'card');
  if v_again is not null then v_fail := v_fail+1; raise warning 'replayed webhook created a second payment'; end if;
  select amount_paid_cents, tip_cents into v_paid, v_tip from invoices where id = v_inv;
  if v_paid <> 19000 or v_tip <> 2000 then
    v_fail := v_fail+1; raise warning 'replay moved the money: paid %, tip %', v_paid, v_tip; end if;

  -- the same idempotency key must not be applied twice either
  perform record_payment(v_inv, 100, 0, null, null, 'autocharge:x:1', true, 'card');
  v_again := record_payment(v_inv, 100, 0, null, null, 'autocharge:x:1', true, 'card');
  if v_again is not null then v_fail := v_fail+1; raise warning 'replayed idempotency key created a second payment'; end if;

  -- a goodwill refund gives money back WITHOUT making it owed again. The
  -- gross figures still move, so reporting is untouched; the matching credit
  -- is what stops the sweep charging the customer for our own apology.
  -- (This invoice is already 100 overpaid from the idempotency-key capture
  -- above, so the balance stays at -100 rather than returning to 0.)
  perform record_refund('pi_money_1', 5000, 're_money_1', null, 'sorry about the shower',
                        'goodwill');
  select refunded_cents, credit_cents, balance_cents, status
    into v_paid, v_credit, v_bal, v_status from invoices where id = v_inv;
  if v_paid <> 5000 then v_fail := v_fail+1; raise warning 'refunded: got %, want 5000', v_paid; end if;
  if v_credit <> 5000 then v_fail := v_fail+1; raise warning 'credit: got %, want 5000', v_credit; end if;
  if v_bal <> -100 then v_fail := v_fail+1; raise warning 'balance after goodwill: got %, want -100', v_bal; end if;
  if v_status <> 'paid' then v_fail := v_fail+1; raise warning 'status after goodwill: got %, want paid', v_status; end if;

  -- refunds are idempotent on the Stripe refund id
  v_again := record_refund('pi_money_1', 5000, 're_money_1', null, null);
  if v_again is not null then v_fail := v_fail+1; raise warning 'replayed refund applied twice'; end if;
  select credit_cents into v_credit from invoices where id = v_inv;
  if v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'a replayed refund credited twice: %', v_credit; end if;

  -- and cannot exceed what that payment captured
  begin
    perform record_refund('pi_money_1', 14001, 're_money_2', null, null);
    v_fail := v_fail+1; raise warning 'over-refund of a payment was accepted';
  exception when others then null; end;

  -- a failed auto-charge spends exactly one attempt
  select attempt_count into v_attempts from invoices where id = v_inv;
  perform record_autocharge_failure(v_inv, 'Your card was declined.', now() + interval '1 day');
  select attempt_count into v_attempts from invoices where id = v_inv;
  if v_attempts <> 1 then v_fail := v_fail+1; raise warning 'attempts: got %, want 1', v_attempts; end if;

  -- a draft is never resettled into 'sent' by a money movement
  declare v_draft uuid;
  begin
    insert into invoices (customer_id, status, subtotal_cents, total_cents)
      values (v_cust, 'draft', 5000, 5000) returning id into v_draft;
    perform resettle_invoice(v_draft);
    select status into v_status from invoices where id = v_draft;
    if v_status <> 'draft' then v_fail := v_fail+1; raise warning 'draft was resettled to %', v_status; end if;
  end;

  if v_fail > 0 then raise exception '% money-path assertions failed', v_fail; end if;
  raise notice 'money mutations passed';
end $$;
SQL
echo "  money paths verified"

# --- the business calendar (0008) -------------------------------------------
# `resettle_invoice` used to decide overdue with `current_date`, which is the
# SESSION's date. On a UTC server that rolled an invoice to overdue at 7pm the
# previous evening in Dallas. The session zone is deliberately set to two very
# different values below: the answer must not move.
echo "  checking the business calendar"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_status invoice_status; v_fail integer := 0;
  v_today date; v_utc_today date;
begin
  insert into customers (first_name, last_name) values ('Calendar','Check')
    returning id into v_cust;

  -- Due TODAY in Dallas. Not overdue, in any session zone.
  insert into invoices (customer_id, status, subtotal_cents, total_cents, due_on)
    values (v_cust, 'sent', 17000, 17000, business_today()) returning id into v_inv;

  set local timezone = 'UTC';
  perform resettle_invoice(v_inv);
  select status into v_status from invoices where id = v_inv;
  if v_status <> 'sent' then v_fail := v_fail+1;
    raise warning 'due today read as % with the session in UTC', v_status; end if;

  set local timezone = 'America/Chicago';
  perform resettle_invoice(v_inv);
  select status into v_status from invoices where id = v_inv;
  if v_status <> 'sent' then v_fail := v_fail+1;
    raise warning 'due today read as % with the session in Chicago', v_status; end if;

  -- Far enough east that the session date is tomorrow while Dallas is still
  -- on today. This is the case a `current_date` comparison gets wrong.
  set local timezone = 'Pacific/Auckland';
  perform resettle_invoice(v_inv);
  select status into v_status from invoices where id = v_inv;
  if v_status <> 'sent' then v_fail := v_fail+1;
    raise warning 'due today read as % with the session in Auckland', v_status; end if;
  reset timezone;

  -- Yesterday in Dallas really is overdue, and stays overdue everywhere.
  update invoices set due_on = business_today() - 1 where id = v_inv;
  set local timezone = 'UTC';
  perform resettle_invoice(v_inv);
  select status into v_status from invoices where id = v_inv;
  if v_status <> 'overdue' then v_fail := v_fail+1;
    raise warning 'a day past due read as %', v_status; end if;
  reset timezone;

  -- And business_today() itself does not follow the session.
  set local timezone = 'Pacific/Auckland';
  v_today := business_today();
  set local timezone = 'UTC';
  v_utc_today := business_today();
  reset timezone;
  if v_today <> v_utc_today then v_fail := v_fail+1;
    raise warning 'business_today() moved with the session: % vs %', v_today, v_utc_today; end if;

  if v_fail > 0 then raise exception '% calendar assertions failed', v_fail; end if;
  raise notice 'business calendar passed';
end $$;
SQL
echo "  business calendar verified"

# --- saved cards (0009) ------------------------------------------------------
# The replay case that the first attempt at this fix got wrong: with TWO cards
# on file, redelivering the DEFAULT card's attach event used to clear its own
# default flag, leaving a customer with saved cards, autopay on, and nothing
# for the sweep to charge.
echo "  checking saved cards"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_other uuid; v_default text; v_fail integer := 0;
  v_is_default boolean; v_count integer;
begin
  insert into customers (first_name, last_name, autopay_enabled, autopay_authorized_at)
    values ('Cards','Onfile', true, now()) returning id into v_cust;

  -- The first card becomes the default, so a customer who has just added one
  -- and switched autopay on is chargeable with no second, invisible step.
  if save_payment_method(v_cust, 'pm_a', 'visa', '4242', 12, 2030) is not true then
    v_fail := v_fail+1; raise warning 'the first card did not become the default'; end if;

  -- The second does not steal the position.
  if save_payment_method(v_cust, 'pm_b', 'visa', '1881', 1, 2031) is not false then
    v_fail := v_fail+1; raise warning 'the second card took the default'; end if;

  -- THE BUG. Stripe redelivers A's attach event. A must stay default.
  if save_payment_method(v_cust, 'pm_a', 'visa', '4242', 12, 2030) is not true then
    v_fail := v_fail+1; raise warning 'replaying the default card cleared its default'; end if;
  select is_default into v_is_default from payment_methods where stripe_payment_method_id = 'pm_a';
  if not v_is_default then v_fail := v_fail+1;
    raise warning 'card A is no longer the default after its own replay'; end if;

  -- Replaying the NON-default card must not promote it either.
  if save_payment_method(v_cust, 'pm_b', 'visa', '1881', 1, 2031) is not false then
    v_fail := v_fail+1; raise warning 'replaying the non-default card promoted it'; end if;

  -- Exactly one default, always.
  select count(*) into v_count from payment_methods
    where customer_id = v_cust and is_default and detached_at is null;
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'expected exactly one default card, found %', v_count; end if;

  -- A metadata update (a card re-issued with a new expiry) keeps the default
  -- and actually updates the metadata.
  perform save_payment_method(v_cust, 'pm_a', 'visa', '4242', 6, 2032);
  select is_default into v_is_default from payment_methods where stripe_payment_method_id = 'pm_a';
  if not v_is_default then v_fail := v_fail+1;
    raise warning 'a metadata update cleared the default'; end if;
  if not exists (select 1 from payment_methods
                 where stripe_payment_method_id = 'pm_a' and exp_year = 2032) then
    v_fail := v_fail+1; raise warning 'the metadata update did not apply'; end if;

  -- Detaching the default promotes the remaining card rather than leaving
  -- the customer unchargeable.
  v_default := detach_payment_method('pm_a');
  if v_default is distinct from 'pm_b' then v_fail := v_fail+1;
    raise warning 'detaching the default promoted % instead of pm_b', v_default; end if;
  if exists (select 1 from payment_methods
             where stripe_payment_method_id = 'pm_a' and detached_at is null) then
    v_fail := v_fail+1; raise warning 'the detached card is still active'; end if;

  -- Replacement: a new card arrives while B holds the default. B keeps it.
  if save_payment_method(v_cust, 'pm_c', 'amex', '0005', 3, 2033) is not false then
    v_fail := v_fail+1; raise warning 'a replacement card seized the default'; end if;

  -- Re-attaching a previously detached card does not seize the default back.
  if save_payment_method(v_cust, 'pm_a', 'visa', '4242', 6, 2032) is not false then
    v_fail := v_fail+1; raise warning 're-attaching an old card seized the default'; end if;

  -- Detaching a NON-default card leaves the default where it is.
  v_default := detach_payment_method('pm_c');
  if v_default is distinct from 'pm_b' then v_fail := v_fail+1;
    raise warning 'detaching a non-default card moved the default to %', v_default; end if;

  -- Detaching an unknown card is a no-op, not an error.
  if detach_payment_method('pm_never_seen') is not null then
    v_fail := v_fail+1; raise warning 'detaching an unmirrored card returned a default'; end if;

  -- THE LAST CARD. Consent is WITHDRAWN with it (0013): an authorisation to
  -- charge a card the customer has removed is stale, and stale consent is not
  -- a position to defend a dispute from. The reason is recorded so the screen
  -- can explain itself rather than just showing "Off".
  perform detach_payment_method('pm_b');
  perform detach_payment_method('pm_a');
  if exists (select 1 from payment_methods
             where customer_id = v_cust and detached_at is null) then
    v_fail := v_fail+1; raise warning 'a card survived detaching them all'; end if;
  if not exists (select 1 from customers where id = v_cust
                 and autopay_enabled = false
                 and autopay_authorized_at is null
                 and autopay_ended_at is not null
                 and autopay_ended_reason is not null) then
    v_fail := v_fail+1;
    raise warning 'removing the last card did not withdraw autopay consent'; end if;

  -- And saving a card does NOT resurrect it. Opting back in is a fresh
  -- decision the customer makes; nothing here may make it for them.
  perform save_payment_method(v_cust, 'pm_d', 'visa', '4444', 9, 2034);
  if exists (select 1 from customers where id = v_cust
             and (autopay_enabled or autopay_authorized_at is not null)) then
    v_fail := v_fail+1;
    raise warning 'saving a card silently re-enabled autopay without consent'; end if;

  -- A card moving to a different customer keeps that customer''s default
  -- arrangement intact rather than inheriting the old one''s.
  insert into customers (first_name, last_name) values ('Second','Customer')
    returning id into v_other;
  perform save_payment_method(v_other, 'pm_e', 'visa', '7777', 4, 2035);
  select count(*) into v_count from payment_methods
    where customer_id = v_other and is_default and detached_at is null;
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'a second customer ended up with % defaults', v_count; end if;

  if v_fail > 0 then raise exception '% saved-card assertions failed', v_fail; end if;
  raise notice 'saved cards passed';
end $$;
SQL
echo "  saved cards verified"

# --- saved cards under concurrency (0009) ------------------------------------
# The single-session assertions above cannot show that the lock is doing
# anything. This runs two real connections that overlap: the first holds a
# transaction open after saving a card, the second saves a different card for
# the same customer while it is held.
#
# With the lock, the second blocks, then sees a default already exists and
# writes itself non-default. Without it, both read "no default yet", both
# claim it, and one of two things happens — two defaults, or a unique
# violation from payment_methods_one_default. Either is a failure here.
echo "  checking saved cards under concurrent saves"
CONCURRENT_CUSTOMER=$(as_super $PSQL -d "$DB" -tAc \
  "insert into customers (first_name, last_name) values ('Concurrent','Save') returning id")

as_super $PSQL -d "$DB" -c "begin;
  select save_payment_method('$CONCURRENT_CUSTOMER', 'pm_race_a', 'visa', '1111', 1, 2030);
  select pg_sleep(2);
  commit;" >/dev/null &
FIRST_SESSION=$!

# Long enough that the first transaction is certainly holding the row.
sleep 0.5
as_super $PSQL -d "$DB" -c \
  "select save_payment_method('$CONCURRENT_CUSTOMER', 'pm_race_b', 'visa', '2222', 1, 2030);" \
  >/dev/null
wait $FIRST_SESSION

as_super $PSQL -d "$DB" <<SQL
do \$\$
declare v_defaults integer; v_cards integer;
begin
  select count(*) into v_defaults from payment_methods
    where customer_id = '$CONCURRENT_CUSTOMER' and is_default and detached_at is null;
  select count(*) into v_cards from payment_methods
    where customer_id = '$CONCURRENT_CUSTOMER' and detached_at is null;
  if v_cards <> 2 then
    raise exception 'concurrent saves stored % cards, want 2', v_cards; end if;
  if v_defaults <> 1 then
    raise exception 'concurrent saves left % default cards, want 1', v_defaults; end if;
  raise notice 'concurrent saves passed';
end \$\$;
SQL
echo "  concurrent saves verified"

# --- webhook event leases (0010) ---------------------------------------------
# 0006's primary key told us an event had been seen. It did not tell us
# whether it had been FINISHED, and the route acknowledged both cases the
# same way — so a retry arriving while the first handler was still running
# was answered "duplicate", Stripe stopped retrying, and if that handler then
# died the payment was never applied.
echo "  checking webhook event leases"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_a uuid := gen_random_uuid();  -- handler A
  v_b uuid := gen_random_uuid();  -- handler B
  v_result text; v_fail integer := 0; v_attempts integer; v_state stripe_event_state;
begin
  -- A first delivery claims.
  if claim_stripe_event('evt_lease_1', 'payment_intent.succeeded', '{}'::jsonb, v_a)
     <> 'claimed' then
    v_fail := v_fail+1; raise warning 'a first delivery did not claim'; end if;

  -- A retry arriving while A holds a live lease is NOT a duplicate. This is
  -- the case that used to be acknowledged and lost.
  v_result := claim_stripe_event('evt_lease_1', 'payment_intent.succeeded', '{}'::jsonb, v_b);
  if v_result <> 'processing' then v_fail := v_fail+1;
    raise warning 'a retry inside the lease reported %, want processing', v_result; end if;

  -- B cannot finish work it does not own, nor release A's claim.
  if finish_stripe_event('evt_lease_1', v_b, 'applied') then
    v_fail := v_fail+1; raise warning 'a non-owner completed another handler''s event'; end if;
  if release_stripe_event('evt_lease_1', v_b) then
    v_fail := v_fail+1; raise warning 'a non-owner released another handler''s claim'; end if;
  select state into v_state from stripe_events where id = 'evt_lease_1';
  if v_state <> 'processing' then v_fail := v_fail+1;
    raise warning 'a non-owner moved the event to %', v_state; end if;

  -- The owner finishes it.
  if not finish_stripe_event('evt_lease_1', v_a, 'applied') then
    v_fail := v_fail+1; raise warning 'the lease owner could not finish its own event'; end if;

  -- Now, and only now, a redelivery is a duplicate — for as long as Stripe
  -- keeps retrying, which is days.
  if claim_stripe_event('evt_lease_1', 'payment_intent.succeeded', '{}'::jsonb, v_b)
     <> 'completed' then
    v_fail := v_fail+1; raise warning 'a redelivery of a finished event was not completed'; end if;

  -- A stale handler waking up after the fact cannot un-finish it.
  if finish_stripe_event('evt_lease_1', v_a, 'applied') then
    v_fail := v_fail+1; raise warning 'a surrendered lease could still finish the event'; end if;

  -- PROCESS TERMINATION. A claims with a one-second lease and never returns.
  perform claim_stripe_event('evt_lease_2', 'checkout.session.completed', '{}'::jsonb, v_a, 1);

  -- A retry BEFORE the lease expires still gets "come back later".
  if claim_stripe_event('evt_lease_2', 'checkout.session.completed', '{}'::jsonb, v_b, 1)
     <> 'processing' then
    v_fail := v_fail+1; raise warning 'a retry before lease expiry was not held off'; end if;

  perform pg_sleep(1.2);

  -- AFTER expiry, the next delivery takes it over rather than being told it
  -- is a duplicate of work that never happened.
  if claim_stripe_event('evt_lease_2', 'checkout.session.completed', '{}'::jsonb, v_b, 60)
     <> 'claimed' then
    v_fail := v_fail+1; raise warning 'an abandoned event was not taken over'; end if;
  select attempts into v_attempts from stripe_events where id = 'evt_lease_2';
  if v_attempts <> 2 then v_fail := v_fail+1;
    raise warning 'takeover recorded % attempts, want 2', v_attempts; end if;

  -- And the handler that died can no longer touch it.
  if finish_stripe_event('evt_lease_2', v_a, 'applied') then
    v_fail := v_fail+1; raise warning 'the dead handler completed an event it had lost'; end if;
  if release_stripe_event('evt_lease_2', v_a) then
    v_fail := v_fail+1; raise warning 'the dead handler released a claim it had lost'; end if;

  -- A DATABASE FAILURE mid-processing: the handler releases, and the retry
  -- picks it up immediately rather than waiting out the lease.
  if not release_stripe_event('evt_lease_2', v_b, 'connection terminated') then
    v_fail := v_fail+1; raise warning 'the owner could not release its own claim'; end if;
  select state into v_state from stripe_events where id = 'evt_lease_2';
  if v_state <> 'failed' then v_fail := v_fail+1;
    raise warning 'a released event is in state %, want failed', v_state; end if;
  if claim_stripe_event('evt_lease_2', 'checkout.session.completed', '{}'::jsonb, v_a, 60)
     <> 'claimed' then
    v_fail := v_fail+1; raise warning 'a released event was not immediately reclaimable'; end if;

  -- The row survives a release, so the audit trail and the attempt count do
  -- too. Deleting it — the old behaviour — lost both.
  select attempts into v_attempts from stripe_events where id = 'evt_lease_2';
  if v_attempts <> 3 then v_fail := v_fail+1;
    raise warning 'attempts after release and reclaim: %, want 3', v_attempts; end if;

  -- OUT OF ORDER: distinct event ids are distinct claims, whatever order
  -- they arrive in.
  if claim_stripe_event('evt_lease_3', 'charge.refunded', '{}'::jsonb, v_b) <> 'claimed' then
    v_fail := v_fail+1; raise warning 'a second distinct event could not be claimed'; end if;

  if v_fail > 0 then raise exception '% webhook lease assertions failed', v_fail; end if;
  raise notice 'webhook leases passed';
end $$;
SQL
echo "  webhook leases verified"

# --- concurrent webhook deliveries (0010) ------------------------------------
# Two connections claiming the same event at the same moment. Exactly one may
# be told to process it; the other must be held off, NOT acknowledged.
echo "  checking concurrent webhook deliveries"
as_super $PSQL -d "$DB" -tAc \
  "select claim_stripe_event('evt_race', 'payment_intent.succeeded', '{}'::jsonb,
                             gen_random_uuid(), 30)" > /tmp/spotless_claim_a.txt &
CLAIM_A=$!
as_super $PSQL -d "$DB" -tAc \
  "select claim_stripe_event('evt_race', 'payment_intent.succeeded', '{}'::jsonb,
                             gen_random_uuid(), 30)" > /tmp/spotless_claim_b.txt &
CLAIM_B=$!
wait $CLAIM_A
wait $CLAIM_B

CLAIMED_COUNT=$(cat /tmp/spotless_claim_a.txt /tmp/spotless_claim_b.txt | grep -c '^claimed$' || true)
HELD_COUNT=$(cat /tmp/spotless_claim_a.txt /tmp/spotless_claim_b.txt | grep -c '^processing$' || true)
rm -f /tmp/spotless_claim_a.txt /tmp/spotless_claim_b.txt

if [ "$CLAIMED_COUNT" != "1" ] || [ "$HELD_COUNT" != "1" ]; then
  echo "  concurrent deliveries: $CLAIMED_COUNT claimed, $HELD_COUNT held — want 1 and 1" >&2
  exit 1
fi
echo "  concurrent deliveries verified"

# --- refund policy (0011) ----------------------------------------------------
# The distinction 0006 did not make: giving money back is not the same as
# deciding it is owed again. Under the old single rule a goodwill refund
# restored the balance, and with autopay on the sweep took it straight back
# off the customer's card — the apology became a second charge.
echo "  checking the refund policy"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_refund uuid; v_fail integer := 0;
  v_paid integer; v_ref integer; v_credit integer; v_bal integer; v_net integer;
  v_status invoice_status; v_paused timestamptz; v_settled text;
begin
  ----------------------------------------------------------------------
  -- THE REQUIRED CASE: $170 invoice, paid in full, $50 goodwill credit
  -- and refund. $120 net retained, $0 outstanding, no new charge.
  ----------------------------------------------------------------------
  insert into customers (first_name, last_name, autopay_enabled, autopay_authorized_at)
    values ('Goodwill','Case', true, now()) returning id into v_cust;
  insert into invoices (customer_id, status, subtotal_cents, total_cents, due_on)
    values (v_cust, 'sent', 17000, 17000, business_today()) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_goodwill', 'ch_goodwill', null, false, 'card');

  select balance_cents, status into v_bal, v_status from invoices where id = v_inv;
  if v_bal <> 0 or v_status <> 'paid' then v_fail := v_fail+1;
    raise warning 'paid in full read as balance %, status %', v_bal, v_status; end if;

  perform record_refund('pi_goodwill', 5000, 're_goodwill', null,
                        'goodwill for the missed bathroom', 'goodwill');

  select amount_paid_cents, refunded_cents, credit_cents, balance_cents, status
    into v_paid, v_ref, v_credit, v_bal, v_status from invoices where id = v_inv;
  v_net := v_paid - v_ref;

  if v_net <> 12000 then v_fail := v_fail+1;
    raise warning 'net retained: got %, want 12000', v_net; end if;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'outstanding after a goodwill refund: got %, want 0', v_bal; end if;
  if v_status <> 'paid' then v_fail := v_fail+1;
    raise warning 'status after a goodwill refund: got %, want paid', v_status; end if;
  if v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'credit raised: got %, want 5000', v_credit; end if;
  -- Gross figures survive: reporting still sees a 17000 job with 5000 given
  -- back, which is what job costing needs.
  if v_paid <> 17000 or v_ref <> 5000 then v_fail := v_fail+1;
    raise warning 'gross figures moved: paid %, refunded %', v_paid, v_ref; end if;

  -- And the sweep has nothing to find. This is the whole point.
  if exists (select 1 from invoices where id = v_inv and balance_cents > 0) then
    v_fail := v_fail+1; raise warning 'a goodwill refund left a collectible balance'; end if;

  ----------------------------------------------------------------------
  -- FULL goodwill refund: nothing retained, nothing owed.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_full', null, null, false, 'card');
  perform record_refund('pi_full', 17000, 're_full', null, 'clean redone elsewhere', 'goodwill');
  select balance_cents, amount_paid_cents - refunded_cents into v_bal, v_net
    from invoices where id = v_inv;
  if v_bal <> 0 or v_net <> 0 then v_fail := v_fail+1;
    raise warning 'full goodwill refund: balance %, net %', v_bal, v_net; end if;

  ----------------------------------------------------------------------
  -- PARTIAL PAYMENT then a goodwill refund. 17000 job, 10000 paid, 5000
  -- back: they owe 12000 - 5000 = 7000, unchanged by the gesture.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 10000, 0, 'pi_partial', null, null, false, 'card');
  perform record_refund('pi_partial', 5000, 're_partial', null, null, 'goodwill');
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> 7000 then v_fail := v_fail+1;
    raise warning 'partial payment then goodwill: balance %, want 7000', v_bal; end if;

  ----------------------------------------------------------------------
  -- A TIP refunded. The tip is in the total, so crediting it back leaves
  -- the invoice settled rather than owing the tip again.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 19000, 2000, 'pi_tip', null, null, false, 'card');
  perform record_refund('pi_tip', 2000, 're_tip', null, 'tip added by mistake', 'goodwill');
  select balance_cents, amount_paid_cents - refunded_cents into v_bal, v_net
    from invoices where id = v_inv;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'refunding a tip left balance %, want 0', v_bal; end if;
  if v_net <> 17000 then v_fail := v_fail+1;
    raise warning 'refunding a tip left net %, want 17000', v_net; end if;

  ----------------------------------------------------------------------
  -- OVERPAYMENT returned. Balance was negative; returning the excess
  -- brings it to zero, and no credit is raised because nothing was
  -- written off.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 20000, 0, 'pi_over', null, null, false, 'card');
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> -3000 then v_fail := v_fail+1;
    raise warning 'overpaid invoice balance: got %, want -3000', v_bal; end if;

  perform record_refund('pi_over', 3000, 're_over', null, 'returned overpayment', 'overpayment');
  select balance_cents, credit_cents into v_bal, v_credit from invoices where id = v_inv;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'returning an overpayment left balance %, want 0', v_bal; end if;
  if v_credit <> 0 then v_fail := v_fail+1;
    raise warning 'returning an overpayment raised a credit of %', v_credit; end if;

  -- Returning more than was overpaid is refused: that is a goodwill refund
  -- wearing the wrong label, and would silently make the invoice collectible.
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_notover', null, null, false, 'card');
  begin
    perform record_refund('pi_notover', 5000, 're_notover', null, null, 'overpayment');
    v_fail := v_fail+1; raise warning 'a non-overpayment was returned as one';
  exception when others then null; end;

  ----------------------------------------------------------------------
  -- CORRECTION. Deliberately collectible again — the money is still owed,
  -- it was just taken the wrong way.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_corr', null, null, false, 'card');
  perform record_refund('pi_corr', 17000, 're_corr', null, 'charged the wrong card', 'correction');
  select balance_cents, credit_cents, status into v_bal, v_credit, v_status
    from invoices where id = v_inv;
  if v_bal <> 17000 then v_fail := v_fail+1;
    raise warning 'a correction left balance %, want 17000', v_bal; end if;
  if v_credit <> 0 then v_fail := v_fail+1;
    raise warning 'a correction raised a credit of %', v_credit; end if;

  ----------------------------------------------------------------------
  -- DISPUTE. Balance restored, automatic collection paused.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_disp', null, null, false, 'card');
  perform record_refund('pi_disp', 17000, 're_disp', null, 'customer disputed', 'dispute');
  select balance_cents, autocharge_paused_at into v_bal, v_paused
    from invoices where id = v_inv;
  if v_bal <> 17000 then v_fail := v_fail+1;
    raise warning 'a dispute refund left balance %, want 17000', v_bal; end if;
  if v_paused is null then v_fail := v_fail+1;
    raise warning 'a dispute refund did not pause automatic collection'; end if;
  perform resume_invoice_autocharge(v_inv);
  if exists (select 1 from invoices where id = v_inv and autocharge_paused_at is not null) then
    v_fail := v_fail+1; raise warning 'a collection pause could not be lifted'; end if;

  ----------------------------------------------------------------------
  -- PENDING refunds touch nothing until Stripe says they succeeded.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_pending', null, null, false, 'card');

  v_refund := record_refund('pi_pending', 5000, 're_pending', null, null, 'goodwill', 'pending');
  select refunded_cents, credit_cents into v_ref, v_credit from invoices where id = v_inv;
  if v_ref <> 0 or v_credit <> 0 then v_fail := v_fail+1;
    raise warning 'a pending refund moved money: refunded %, credit %', v_ref, v_credit; end if;

  v_settled := settle_refund('re_pending', 'succeeded');
  if v_settled <> 'succeeded' then v_fail := v_fail+1;
    raise warning 'settling a pending refund reported %', v_settled; end if;
  select refunded_cents, credit_cents into v_ref, v_credit from invoices where id = v_inv;
  if v_ref <> 5000 or v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'settling did not apply: refunded %, credit %', v_ref, v_credit; end if;

  -- Settling twice is a webhook replay, and a no-op.
  if settle_refund('re_pending', 'succeeded') <> 'unchanged' then v_fail := v_fail+1;
    raise warning 'settling an already-settled refund was not a no-op'; end if;
  select refunded_cents into v_ref from invoices where id = v_inv;
  if v_ref <> 5000 then v_fail := v_fail+1;
    raise warning 'a replayed settlement refunded twice: %', v_ref; end if;

  ----------------------------------------------------------------------
  -- FAILED refunds move nothing, and free the amount up again.
  ----------------------------------------------------------------------
  perform record_refund('pi_pending', 4000, 're_failing', null, null, 'goodwill', 'pending');
  if settle_refund('re_failing', 'failed') <> 'failed' then v_fail := v_fail+1;
    raise warning 'settling a refund as failed reported the wrong outcome'; end if;
  select refunded_cents, credit_cents into v_ref, v_credit from invoices where id = v_inv;
  if v_ref <> 5000 or v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'a failed refund moved money: refunded %, credit %', v_ref, v_credit; end if;

  -- A refund Stripe never heard of is reported, not invented.
  if settle_refund('re_never_existed', 'succeeded') <> 'unknown' then v_fail := v_fail+1;
    raise warning 'settling an unknown refund did not report unknown'; end if;

  ----------------------------------------------------------------------
  -- A credit on its own — a discount agreed after the fact.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_invoice_credit(v_inv, 2000, 'agreed discount');
  select balance_cents, status into v_bal, v_status from invoices where id = v_inv;
  if v_bal <> 15000 then v_fail := v_fail+1;
    raise warning 'a standalone credit left balance %, want 15000', v_bal; end if;

  if v_fail > 0 then raise exception '% refund-policy assertions failed', v_fail; end if;
  raise notice 'refund policy passed';
end $$;
SQL
echo "  refund policy verified"

# --- payment operations (0012) -----------------------------------------------
# Nothing used to record that a collection attempt was in flight, so anything
# that looked at the invoice saw an unpaid invoice and started another one:
# two Checkout tabs, a repeated submission, or the nightly sweep landing on
# an invoice a customer was in the middle of paying.
# --- refund attribution (0013) ------------------------------------------------
# A refund nobody explained is still fully credited and still never
# re-collected — the money rule from 0011 is unchanged. What 0013 adds is
# honest attribution: recording every unexplained refund as pure goodwill
# hides the ones that were a service failure, and those are the ones a
# marketplace has to be able to see.
echo "  checking refund attribution"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_fail integer := 0;
  v_bal integer; v_credit integer; v_service integer; v_goodwill integer;
begin
  insert into customers (first_name, last_name) values ('Attribute','Refund')
    returning id into v_cust;

  ----------------------------------------------------------------------
  -- UNATTRIBUTED (the Stripe-dashboard default): 50/50, fully credited.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_attr_1', null, null, false, 'card');
  perform record_refund('pi_attr_1', 5000, 're_attr_1');   -- kind defaults

  if not exists (select 1 from refunds
                 where stripe_refund_id = 're_attr_1' and kind = 'unattributed') then
    v_fail := v_fail+1; raise warning 'an unstated refund was not recorded as unattributed'; end if;

  select coalesce(sum(amount_cents) filter (where category = 'service_refund'), 0),
         coalesce(sum(amount_cents) filter (where category = 'goodwill'), 0)
    into v_service, v_goodwill
  from invoice_adjustments where invoice_id = v_inv;

  if v_service <> 2500 then v_fail := v_fail+1;
    raise warning 'service share: got %, want 2500', v_service; end if;
  if v_goodwill <> 2500 then v_fail := v_fail+1;
    raise warning 'goodwill share: got %, want 2500', v_goodwill; end if;

  -- The money rule is untouched: fully credited, nothing collectible.
  select credit_cents, balance_cents into v_credit, v_bal from invoices where id = v_inv;
  if v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'total credit: got %, want 5000', v_credit; end if;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'an unattributed refund left % collectible, want 0', v_bal; end if;

  -- Replay must not credit either half twice.
  perform record_refund('pi_attr_1', 5000, 're_attr_1');
  select credit_cents into v_credit from invoices where id = v_inv;
  if v_credit <> 5000 then v_fail := v_fail+1;
    raise warning 'a replayed unattributed refund credited twice: %', v_credit; end if;
  if (select count(*) from invoice_adjustments where invoice_id = v_inv) <> 2 then
    v_fail := v_fail+1; raise warning 'a replay produced extra adjustment rows'; end if;

  ----------------------------------------------------------------------
  -- The ODD CENT goes to goodwill, so the service-failure figure — which
  -- is what drives quality work — is never overstated.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_attr_odd', null, null, false, 'card');
  perform record_refund('pi_attr_odd', 501, 're_attr_odd');

  select coalesce(sum(amount_cents) filter (where category = 'service_refund'), 0),
         coalesce(sum(amount_cents) filter (where category = 'goodwill'), 0)
    into v_service, v_goodwill
  from invoice_adjustments where invoice_id = v_inv;
  if v_service <> 250 or v_goodwill <> 251 then v_fail := v_fail+1;
    raise warning 'odd split: service %, goodwill %, want 250/251', v_service, v_goodwill; end if;
  select credit_cents into v_credit from invoices where id = v_inv;
  if v_credit <> 501 then v_fail := v_fail+1;
    raise warning 'odd split lost a cent: credited %, refunded 501', v_credit; end if;

  ----------------------------------------------------------------------
  -- An admin who KNOWS the clean was the problem gets an undiluted number.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_attr_svc', null, null, false, 'card');
  perform record_refund('pi_attr_svc', 5000, 're_attr_svc', null,
                        'bathroom was missed', 'service_refund');

  select coalesce(sum(amount_cents) filter (where category = 'service_refund'), 0),
         coalesce(sum(amount_cents) filter (where category = 'goodwill'), 0)
    into v_service, v_goodwill
  from invoice_adjustments where invoice_id = v_inv;
  if v_service <> 5000 or v_goodwill <> 0 then v_fail := v_fail+1;
    raise warning 'a stated service refund split: service %, goodwill %', v_service, v_goodwill; end if;
  select balance_cents into v_bal from invoices where id = v_inv;
  if v_bal <> 0 then v_fail := v_fail+1;
    raise warning 'a service refund left % collectible, want 0', v_bal; end if;

  ----------------------------------------------------------------------
  -- A stated goodwill refund is still wholly goodwill.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_attr_gw', null, null, false, 'card');
  perform record_refund('pi_attr_gw', 5000, 're_attr_gw', null, 'thanks for your patience',
                        'goodwill');
  select coalesce(sum(amount_cents) filter (where category = 'goodwill'), 0)
    into v_goodwill from invoice_adjustments where invoice_id = v_inv;
  if v_goodwill <> 5000 then v_fail := v_fail+1;
    raise warning 'a stated goodwill refund credited % to goodwill, want 5000', v_goodwill; end if;

  ----------------------------------------------------------------------
  -- The kinds that deliberately stay collectible raise no credit at all.
  ----------------------------------------------------------------------
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;
  perform record_payment(v_inv, 17000, 0, 'pi_attr_corr', null, null, false, 'card');
  perform record_refund('pi_attr_corr', 17000, 're_attr_corr', null, 'wrong card', 'correction');
  select credit_cents, balance_cents into v_credit, v_bal from invoices where id = v_inv;
  if v_credit <> 0 or v_bal <> 17000 then v_fail := v_fail+1;
    raise warning 'a correction credited % and left balance %', v_credit, v_bal; end if;

  if v_fail > 0 then raise exception '% refund-attribution assertions failed', v_fail; end if;
  raise notice 'refund attribution passed';
end $$;
SQL
echo "  refund attribution verified"

echo "  checking payment operations"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_inv uuid; v_other uuid; v_fail integer := 0;
  v_op record; v_count integer;
begin
  insert into customers (first_name, last_name) values ('Collect','Once')
    returning id into v_cust;
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_inv;

  -- TWO CHECKOUT TABS. Same invoice, same balance, same key: the second must
  -- join the first, not open a second chargeable page.
  select * into v_op from begin_payment_operation(v_inv, 'checkout', 'checkout:a:17000:0', 17000);
  if v_op.outcome <> 'started' then v_fail := v_fail+1;
    raise warning 'the first tab reported %', v_op.outcome; end if;
  perform attach_payment_operation('checkout:a:17000:0', 'checkout_session', 'cs_1',
                                   'https://checkout.test/cs_1');

  select * into v_op from begin_payment_operation(v_inv, 'checkout', 'checkout:a:17000:0', 17000);
  if v_op.outcome <> 'existing' then v_fail := v_fail+1;
    raise warning 'the second tab reported %, want existing', v_op.outcome; end if;
  if v_op.redirect_url is distinct from 'https://checkout.test/cs_1' then v_fail := v_fail+1;
    raise warning 'the second tab was not sent to the existing session'; end if;

  -- CHECKOUT OVERLAPPING AUTOCHARGE. Different channel, different Stripe
  -- idempotency key — Stripe would see two unrelated charges. Refused here.
  select * into v_op from begin_payment_operation(v_inv, 'autocharge', 'autocharge:x:1', 17000);
  if v_op.outcome <> 'blocked' then v_fail := v_fail+1;
    raise warning 'the sweep reported % while Checkout was open, want blocked', v_op.outcome; end if;
  if v_op.channel <> 'checkout' then v_fail := v_fail+1;
    raise warning 'the block named the wrong channel: %', v_op.channel; end if;

  -- Exactly one attempt, whatever anyone asked for.
  select count(*) into v_count from payment_operations
    where invoice_id = v_inv and state = 'open';
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'expected one open attempt, found %', v_count; end if;

  -- REPEATED SUBMISSION after the first finished. Not a fresh attempt.
  perform resolve_payment_operation('checkout:a:17000:0', 'succeeded');
  select * into v_op from begin_payment_operation(v_inv, 'checkout', 'checkout:a:17000:0', 17000);
  if v_op.outcome <> 'existing' then v_fail := v_fail+1;
    raise warning 'a resubmitted key started a new attempt (%)', v_op.outcome; end if;
  select count(*) into v_count from payment_operations
    where idempotency_key = 'checkout:a:17000:0';
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'a resubmitted key produced % rows', v_count; end if;

  -- THE SWEEP GOES FIRST. Mirror image: Checkout must be refused while an
  -- off-session charge is outstanding, because we cannot yet know it failed.
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_other;
  perform begin_payment_operation(v_other, 'autocharge', 'autocharge:y:1', 17000);
  select * into v_op from begin_payment_operation(v_other, 'checkout', 'checkout:y:17000:0', 17000);
  if v_op.outcome <> 'blocked' then v_fail := v_fail+1;
    raise warning 'Checkout was allowed alongside an off-session charge'; end if;

  -- A DEAD PROCESS must not hold the invoice for ever.
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_other;
  perform begin_payment_operation(v_other, 'checkout', 'checkout:z:17000:0', 17000, 1);
  perform pg_sleep(1.2);
  select * into v_op from begin_payment_operation(v_other, 'autocharge', 'autocharge:z:1', 17000);
  if v_op.outcome <> 'started' then v_fail := v_fail+1;
    raise warning 'an expired attempt still blocked the invoice (%)', v_op.outcome; end if;
  if not exists (select 1 from payment_operations
                 where idempotency_key = 'checkout:z:17000:0' and state = 'abandoned') then
    v_fail := v_fail+1; raise warning 'the expired attempt was not marked abandoned'; end if;

  -- The database, not just the code, enforces one open attempt per invoice.
  begin
    insert into payment_operations (invoice_id, channel, idempotency_key, amount_cents, expires_at)
    values (v_other, 'checkout', 'checkout:z:sneak', 17000, now() + interval '1 hour');
    v_fail := v_fail+1; raise warning 'a second open attempt was inserted directly';
  exception when unique_violation then null; end;

  -- A settled payment closes its attempt, by whichever reference we hold.
  insert into invoices (customer_id, status, subtotal_cents, total_cents)
    values (v_cust, 'sent', 17000, 17000) returning id into v_other;
  perform begin_payment_operation(v_other, 'checkout', 'checkout:w:17000:0', 17000);
  perform attach_payment_operation('checkout:w:17000:0', 'checkout_session', 'cs_w');
  if not settle_payment_operation_by_ref(v_other, 'cs_w') then v_fail := v_fail+1;
    raise warning 'settling by session reference did not close the attempt'; end if;
  if exists (select 1 from payment_operations where idempotency_key = 'checkout:w:17000:0'
             and state <> 'succeeded') then
    v_fail := v_fail+1; raise warning 'the settled attempt is not succeeded'; end if;

  -- Settling something with no attempt behind it is a no-op, not an error:
  -- plenty of payments predate this table.
  if settle_payment_operation_by_ref(v_other, 'cs_never_seen') then v_fail := v_fail+1;
    raise warning 'settling an unknown reference reported success'; end if;

  if v_fail > 0 then raise exception '% payment-operation assertions failed', v_fail; end if;
  raise notice 'payment operations passed';
end $$;
SQL
echo "  payment operations verified"

# --- concurrent collection attempts (0012) -----------------------------------
# Two connections asking to collect the same invoice at the same instant.
# Exactly one may start; the other must be told to join or wait.
echo "  checking concurrent collection attempts"
COLLECT_INVOICE=$(as_super $PSQL -d "$DB" -tAc \
  "with c as (insert into customers (first_name, last_name)
              values ('Race','Collect') returning id)
   insert into invoices (customer_id, status, subtotal_cents, total_cents)
   select id, 'sent', 17000, 17000 from c returning id")

as_super $PSQL -d "$DB" -tAc \
  "select outcome from begin_payment_operation('$COLLECT_INVOICE', 'checkout',
                                               'checkout:race:a', 17000)" \
  > /tmp/spotless_collect_a.txt 2>&1 &
RACE_A=$!
as_super $PSQL -d "$DB" -tAc \
  "select outcome from begin_payment_operation('$COLLECT_INVOICE', 'autocharge',
                                               'autocharge:race:1', 17000)" \
  > /tmp/spotless_collect_b.txt 2>&1 &
RACE_B=$!
wait $RACE_A
wait $RACE_B

STARTED=$(cat /tmp/spotless_collect_a.txt /tmp/spotless_collect_b.txt | grep -c '^started$' || true)
BLOCKED=$(cat /tmp/spotless_collect_a.txt /tmp/spotless_collect_b.txt | grep -c '^blocked$' || true)
rm -f /tmp/spotless_collect_a.txt /tmp/spotless_collect_b.txt

if [ "$STARTED" != "1" ] || [ "$BLOCKED" != "1" ]; then
  echo "  concurrent collection: $STARTED started, $BLOCKED blocked — want 1 and 1" >&2
  exit 1
fi
echo "  concurrent collection verified"

# --- recurring generation (0014) ----------------------------------------------
# A recurring customer is the relationship the business is built on, so the
# two failures that matter both repeat every cycle: a visit generated twice
# is a double booking and a double charge, and a visit never generated is a
# customer in a dirty house. The unique index on (plan, occurrence date) is
# what makes the first impossible.
echo "  checking recurring generation"
as_super $PSQL -d "$DB" <<'SQL'
do $$
declare
  v_cust uuid; v_prop uuid; v_plan uuid; v_cleaner uuid;
  v_job uuid; v_again uuid; v_count integer; v_fail integer := 0;
  v_price integer; v_status job_status; v_freq frequency;
begin
  insert into customers (first_name, last_name) values ('Recur','Ring')
    returning id into v_cust;
  insert into properties (customer_id, street, city, zip, bedrooms, bathrooms)
    values (v_cust, '18 Cedar Bend', 'Plano', '75024', 2, 2) returning id into v_prop;

  insert into recurring_plans (customer_id, property_id, freq, service,
                               agreed_price_cents, estimated_minutes, anchor_date,
                               start_time)
  values (v_cust, v_prop, 'biweekly', 'standard', 15900, 120, date '2026-09-15', '09:30')
  returning id into v_plan;

  -- Generating an occurrence creates exactly one job at the PLAN's rate.
  v_job := materialise_recurring_job(v_plan, date '2026-09-15',
                                     timestamptz '2026-09-15 14:30:00+00');
  if v_job is null then v_fail := v_fail+1;
    raise warning 'the first generation produced no job'; end if;

  select price_cents, status, freq into v_price, v_status, v_freq
    from jobs where id = v_job;
  if v_price <> 15900 then v_fail := v_fail+1;
    raise warning 'job priced at %, want the plan rate 15900', v_price; end if;
  if v_status <> 'scheduled' then v_fail := v_fail+1;
    raise warning 'generated job status %, want scheduled', v_status; end if;
  if v_freq <> 'biweekly' then v_fail := v_fail+1;
    raise warning 'generated job freq %, want biweekly', v_freq; end if;

  -- THE GUARANTEE. The sweep runs daily across a six-week horizon, so every
  -- occurrence is seen dozens of times before it happens. All no-ops.
  v_again := materialise_recurring_job(v_plan, date '2026-09-15',
                                       timestamptz '2026-09-15 14:30:00+00');
  if v_again is distinct from v_job then v_fail := v_fail+1;
    raise warning 'regenerating returned % instead of the existing %', v_again, v_job; end if;
  select count(*) into v_count from jobs
    where recurring_plan_id = v_plan and occurrence_date = date '2026-09-15';
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'one occurrence produced % jobs', v_count; end if;

  -- The price on an ALREADY GENERATED job is not rewritten when the plan
  -- rate changes. What they agreed to for that visit is what they pay.
  update recurring_plans set agreed_price_cents = 20000 where id = v_plan;
  perform materialise_recurring_job(v_plan, date '2026-09-15',
                                    timestamptz '2026-09-15 14:30:00+00');
  select price_cents into v_price from jobs where id = v_job;
  if v_price <> 15900 then v_fail := v_fail+1;
    raise warning 'a plan price change rewrote an existing visit to %', v_price; end if;
  update recurring_plans set agreed_price_cents = 15900 where id = v_plan;

  -- A RESCHEDULE moves the visit without freeing its slot to be regenerated.
  update jobs set scheduled_start = timestamptz '2026-09-16 15:00:00+00' where id = v_job;
  perform materialise_recurring_job(v_plan, date '2026-09-15',
                                    timestamptz '2026-09-15 14:30:00+00');
  select count(*) into v_count from jobs where recurring_plan_id = v_plan;
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'rescheduling a visit let its original slot regenerate (% jobs)', v_count; end if;

  -- A SKIP cancels the visit and stops it coming back.
  perform materialise_recurring_job(v_plan, date '2026-09-29',
                                    timestamptz '2026-09-29 14:30:00+00');
  perform skip_recurring_occurrence(v_plan, date '2026-09-29', 'customer away');
  select status into v_status from jobs
    where recurring_plan_id = v_plan and occurrence_date = date '2026-09-29';
  if v_status <> 'canceled' then v_fail := v_fail+1;
    raise warning 'a skipped visit is %, want canceled', v_status; end if;

  if materialise_recurring_job(v_plan, date '2026-09-29',
                               timestamptz '2026-09-29 14:30:00+00') is not null then
    v_fail := v_fail+1; raise warning 'a skipped occurrence was regenerated'; end if;

  -- Skipping twice is a no-op, not an error: a person clicking twice, or a
  -- retry, must not blow up.
  perform skip_recurring_occurrence(v_plan, date '2026-09-29', 'customer away');
  select count(*) into v_count from recurring_plan_skips
    where plan_id = v_plan and occurrence_date = date '2026-09-29';
  if v_count <> 1 then v_fail := v_fail+1;
    raise warning 'skipping twice produced % rows', v_count; end if;

  -- The skip is a ROW, so "why was there no clean on the 29th" has an answer
  -- months later.
  if not exists (select 1 from recurring_plan_skips
                 where plan_id = v_plan and occurrence_date = date '2026-09-29'
                   and reason = 'customer away') then
    v_fail := v_fail+1; raise warning 'the skip did not record why'; end if;

  -- UNSKIP puts it back in play.
  if not unskip_recurring_occurrence(v_plan, date '2026-09-29') then
    v_fail := v_fail+1; raise warning 'unskipping a skipped occurrence reported nothing'; end if;
  if materialise_recurring_job(v_plan, date '2026-09-29',
                               timestamptz '2026-09-29 14:30:00+00') is null then
    v_fail := v_fail+1; raise warning 'an unskipped occurrence did not regenerate'; end if;

  -- A visit that has already happened is not skippable. Cancelling a
  -- completed clean is a different act with different money attached.
  perform materialise_recurring_job(v_plan, date '2026-10-13',
                                    timestamptz '2026-10-13 14:30:00+00');
  update jobs set status = 'complete'
    where recurring_plan_id = v_plan and occurrence_date = date '2026-10-13';
  begin
    perform skip_recurring_occurrence(v_plan, date '2026-10-13', 'too late');
    v_fail := v_fail+1; raise warning 'a completed visit was skipped';
  exception when others then null; end;

  -- An inactive plan generates nothing.
  update recurring_plans set active = false where id = v_plan;
  begin
    perform materialise_recurring_job(v_plan, date '2026-10-27',
                                      timestamptz '2026-10-27 14:30:00+00');
    v_fail := v_fail+1; raise warning 'an inactive plan generated a visit';
  exception when others then null; end;
  update recurring_plans set active = true where id = v_plan;

  -- A plan cannot be active with no anchor: it could not say when anything
  -- happens, and a silent no-op is worse than a refused write.
  begin
    update recurring_plans set anchor_date = null where id = v_plan;
    v_fail := v_fail+1; raise warning 'an active plan was allowed with no anchor';
  exception when check_violation then null; end;

  if v_fail > 0 then raise exception '% recurring assertions failed', v_fail; end if;
  raise notice 'recurring generation passed';
end $$;
SQL
echo "  recurring generation verified"

# --- concurrent recurring generation (0014) -----------------------------------
# Two sweeps landing on the same occurrence at the same moment. The unique
# index must leave exactly one job — a double booking here is a double charge
# to a customer who has one every fortnight.
echo "  checking concurrent recurring generation"
RECUR_PLAN=$(as_super $PSQL -d "$DB" -tAc \
  "with c as (insert into customers (first_name, last_name)
              values ('Race','Recur') returning id),
        p as (insert into properties (customer_id, street, city, zip, bedrooms, bathrooms)
              select id, '2 Race Way', 'Plano', '75024', 2, 2 from c returning id, customer_id)
   insert into recurring_plans (customer_id, property_id, freq, service,
                               agreed_price_cents, estimated_minutes, anchor_date, start_time)
   select p.customer_id, p.id, 'weekly', 'standard', 15900, 120, date '2026-09-15', '09:30'
   from p returning id")

for i in 1 2 3; do
  as_super $PSQL -d "$DB" -tAc \
    "select materialise_recurring_job('$RECUR_PLAN', date '2026-09-22',
                                      timestamptz '2026-09-22 14:30:00+00')" \
    > /dev/null 2>&1 &
done
wait

RECUR_JOBS=$(as_super $PSQL -d "$DB" -tAc \
  "select count(*) from jobs where recurring_plan_id = '$RECUR_PLAN'
   and occurrence_date = date '2026-09-22'")

if [ "$RECUR_JOBS" != "1" ]; then
  echo "  three concurrent sweeps created $RECUR_JOBS jobs for one occurrence — want 1" >&2
  exit 1
fi
echo "  concurrent recurring generation verified"

echo "  checking customer, cleaner and server access"
as_super $PSQL -d "$DB" -f scripts/verify-access.sql
echo "  access controls verified"
