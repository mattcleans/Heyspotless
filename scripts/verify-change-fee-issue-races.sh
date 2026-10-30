#!/usr/bin/env bash
# Disposable database only. Actual separate sessions race issuance, not providers.
set -euo pipefail
FEE_DB="${1:?pass disposable database}"
FEE_DIR=$(mktemp -d)
trap 'rm -rf "$FEE_DIR"' EXIT
fee_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$FEE_DB" "$@"; }
fee_barrier() {
 local seen
 for _ in $(seq 1 100); do
  seen=$(fee_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='change_fee_first' and wait_event='PgSleep'")
  if [ "$seen" = 1 ];then return;fi
  sleep .05
 done
 echo 'Fee issuer did not reach the observed lock barrier' >&2;return 1
}
fee_sql <<'SQL'
insert into auth.users(id,email) values
 ('fb100000-0000-4000-8000-000000000001','fee-race-client@example.test'),
 ('fb100000-0000-4000-8000-000000000002','fee-race-office@example.test');
update public.profiles set role='admin' where id='fb100000-0000-4000-8000-000000000002';
insert into public.customers(id,profile_id,first_name,last_name) values('fb200000-0000-4000-8000-000000000001','fb100000-0000-4000-8000-000000000001','Synthetic fee race','Client');
insert into public.properties(id,customer_id,street,city,zip) values('fb300000-0000-4000-8000-000000000001','fb200000-0000-4000-8000-000000000001','Synthetic fee race home','Dallas','75001');
insert into public.jobs(id,customer_id,property_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes)
select ('fb500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'fb200000-0000-4000-8000-000000000001','fb300000-0000-4000-8000-000000000001','scheduled','standard','one_time',clock_timestamp(),19900,90 from generate_series(1,2) n;
select set_config('request.jwt.claim.sub','fb100000-0000-4000-8000-000000000001',false);
set role authenticated;
select public.confirm_my_visit_cancellation('fb500000-0000-4000-8000-000000000001',(public.quote_my_visit_cancellation('fb500000-0000-4000-8000-000000000001','cancel')->>'id')::uuid);
select public.confirm_my_visit_reschedule('fb500000-0000-4000-8000-000000000002',(public.quote_my_visit_reschedule_with_fee('fb500000-0000-4000-8000-000000000002',date_trunc('minute',clock_timestamp()+interval '2 days'))->>'id')::uuid);
SQL
# Same review in two sessions: one saved issuance receipt, including lost reply recovery.
PGAPPNAME=change_fee_first fee_sql >"$FEE_DIR/first" <<'SQL' &
begin;
select public.issue_reviewed_change_fee(invoice_id,id,'cancellation_fee','fb100000-0000-4000-8000-000000000002',6000,(clock_timestamp() at time zone 'America/Chicago')::date+1) from public.visit_cancellations where job_id='fb500000-0000-4000-8000-000000000001';
select pg_sleep(2);
commit;
SQL
FEE_PID=$!
fee_barrier
fee_sql <<'SQL'
select public.issue_reviewed_change_fee(invoice_id,id,'cancellation_fee','fb100000-0000-4000-8000-000000000002',6000,(clock_timestamp() at time zone 'America/Chicago')::date+1) from public.visit_cancellations where job_id='fb500000-0000-4000-8000-000000000001';
SQL
wait "$FEE_PID"
# Different due dates: the losing review must not overwrite the first issuance.
PGAPPNAME=change_fee_first fee_sql >"$FEE_DIR/first" <<'SQL' &
begin;
select public.issue_reviewed_change_fee(invoice_id,id,'reschedule_fee','fb100000-0000-4000-8000-000000000002',6000,(clock_timestamp() at time zone 'America/Chicago')::date+1) from public.visit_reschedules where job_id='fb500000-0000-4000-8000-000000000002';
select pg_sleep(2);
commit;
SQL
FEE_PID=$!
fee_barrier
if fee_sql >"$FEE_DIR/stale" 2>&1 <<'SQL'
\set VERBOSITY verbose
select public.issue_reviewed_change_fee(invoice_id,id,'reschedule_fee','fb100000-0000-4000-8000-000000000002',6000,(clock_timestamp() at time zone 'America/Chicago')::date+2) from public.visit_reschedules where job_id='fb500000-0000-4000-8000-000000000002';
SQL
then echo 'Concurrent stale fee review overwrote issuance' >&2;exit 1;fi
wait "$FEE_PID"
if ! grep -q 'PIF01' "$FEE_DIR/stale";then cat "$FEE_DIR/stale";exit 1;fi
fee_sql <<'SQL'
do $$ begin
 if (select count(*) from spotless_private.change_fee_issuances where customer_id='fb200000-0000-4000-8000-000000000001' and total_cents=6000 and due_on=(clock_timestamp() at time zone 'America/Chicago')::date+1)<>2 then raise exception 'Concurrent fee receipts diverged';end if;
 if (select count(*) from public.invoices where customer_id='fb200000-0000-4000-8000-000000000001' and status='sent' and total_cents=6000 and issued_at is not null)<>2 then raise exception 'Concurrent fee invoice duplicated';end if;
 if exists(select 1 from public.payments where customer_id='fb200000-0000-4000-8000-000000000001') or exists(select 1 from public.payment_operations p join public.invoices i on i.id=p.invoice_id where i.customer_id='fb200000-0000-4000-8000-000000000001') then raise exception 'Fee issuance started payment';end if;
 raise notice 'Fee issue races: one receipt per change, stale concurrent date rejected, no provider or payment claim';
end $$;
SQL
