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
  v_paid integer; v_tip integer; v_total integer; v_bal integer;
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

  -- a partial refund restores balance and reopens the invoice
  perform record_refund('pi_money_1', 5000, 're_money_1', null, 'goodwill');
  select refunded_cents, balance_cents, status into v_paid, v_bal, v_status
    from invoices where id = v_inv;
  if v_paid <> 5000 then v_fail := v_fail+1; raise warning 'refunded: got %, want 5000', v_paid; end if;
  if v_bal  <> 4900 then v_fail := v_fail+1; raise warning 'balance after refund: got %, want 4900', v_bal; end if;
  if v_status <> 'overdue' then v_fail := v_fail+1; raise warning 'status after refund: got %, want overdue', v_status; end if;

  -- refunds are idempotent on the Stripe refund id
  v_again := record_refund('pi_money_1', 5000, 're_money_1', null, null);
  if v_again is not null then v_fail := v_fail+1; raise warning 'replayed refund applied twice'; end if;

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

echo "  checking customer, cleaner and server access"
as_super $PSQL -d "$DB" -f scripts/verify-access.sql
echo "  access controls verified"
