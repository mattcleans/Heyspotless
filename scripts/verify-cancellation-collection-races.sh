#!/usr/bin/env bash
# Disposable database only; provider outcomes below are local ledger fixtures.
set -euo pipefail
CANCEL_DB="${1:?pass disposable database}"
CANCEL_DIR=$(mktemp -d)
trap 'rm -rf "$CANCEL_DIR"' EXIT
cancel_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$CANCEL_DB" "$@"; }
cancel_barrier() {
 local cancel_app="$1" cancel_seen
 for _ in $(seq 1 100); do
  cancel_seen=$(cancel_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$cancel_app' and wait_event='PgSleep'")
  if [ "$cancel_seen" = 1 ];then return;fi
  sleep .05
 done
 echo "cancellation race missed observed barrier: $cancel_app" >&2
 return 1
}
cancel_sql <<'SQL'
insert into auth.users(id,email) values
 ('d1100000-0000-0000-0000-000000000001','cancel-race-client@example.test'),
 ('d1100000-0000-0000-0000-000000000002','cancel-race-office@example.test');
update profiles set role='admin' where id='d1100000-0000-0000-0000-000000000002';
insert into customers(id,profile_id,first_name,last_name) values
 ('d1200000-0000-0000-0000-000000000001','d1100000-0000-0000-0000-000000000001','Cancel race','Client');
insert into properties(id,customer_id,street,city,zip) values
 ('d1300000-0000-0000-0000-000000000001','d1200000-0000-0000-0000-000000000001','Fictional race home','Dallas','75001');
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
 select ('d1500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'d1200000-0000-0000-0000-000000000001',
 'd1300000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,60,clock_timestamp() from generate_series(1,5)n;
insert into invoices(id,job_id,customer_id,status,subtotal_cents,total_cents,issued_at)
 select ('d1700000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 ('d1500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'d1200000-0000-0000-0000-000000000001','sent',20000,20000,clock_timestamp() from generate_series(1,5)n;
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',false);
set role authenticated;
select quote_my_visit_cancellation(('d1500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cancel') from generate_series(1,5)n;
SQL
# Cancellation holds the invoice first: the former clean cannot start collecting.
PGAPPNAME=cancel_before_collection cancel_sql >"$CANCEL_DIR/cancel" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000001',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000001'));
select pg_sleep(2);
commit;
SQL
CANCEL_PID=$!
cancel_barrier cancel_before_collection
cancel_sql <<'SQL'
do $$ begin
 begin perform begin_payment_operation('d1700000-0000-0000-0000-000000000001','checkout','cancel-race-old-clean',20000,900);
 raise exception 'Canceled clean started collecting';exception when check_violation then null;end;
end $$;
SQL
wait "$CANCEL_PID"
# Collection holds the invoice first: cancel now, retain the uncertain operation.
PGAPPNAME=collection_before_cancel cancel_sql >"$CANCEL_DIR/collection" <<'SQL' &
begin;
select begin_payment_operation('d1700000-0000-0000-0000-000000000002','checkout','cancel-race-inflight',20000,900);
select pg_sleep(2);
commit;
SQL
CANCEL_PID=$!
cancel_barrier collection_before_cancel
cancel_sql <<'SQL'
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',false);
set role authenticated;
do $$ declare r jsonb;begin
 r:=confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000002',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000002'));
 if not (r->>'billing_review')::boolean or r->>'invoice_id' is not null then raise exception 'In-flight payment replaced by fee';end if;
end $$;
reset role;
do $$ begin
 if (select count(*) from payment_operations where idempotency_key='cancel-race-inflight' and state='open')<>1 then raise exception 'Uncertain operation lost';end if;
 if (select amount_paid_cents from invoices where id='d1700000-0000-0000-0000-000000000002')<>0 then raise exception 'Payment outcome invented';end if;
end $$;
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000002',false);
set role authenticated;
do $$ begin begin
 perform resolve_visit_cancellation_billing('d1500000-0000-0000-0000-000000000002',(select id from visit_cancellations where job_id='d1500000-0000-0000-0000-000000000002'));
 raise exception 'Unknown payment reconciled';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$CANCEL_PID"
# Two confirmation requests recover one receipt and one fee.
PGAPPNAME=cancel_retry_first cancel_sql >"$CANCEL_DIR/retry" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000003',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000003'));
select pg_sleep(2);
commit;
SQL
CANCEL_PID=$!
cancel_barrier cancel_retry_first
cancel_sql <<'SQL'
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',false);
set role authenticated;
select confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000003',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000003'));
SQL
wait "$CANCEL_PID"
# A locally recorded definitive decline permits reconciliation; retries agree.
cancel_sql -c "select resolve_payment_operation('cancel-race-inflight','failed','Fixture: provider confirmed decline')"
PGAPPNAME=cancel_resolve_first cancel_sql >"$CANCEL_DIR/resolve" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select resolve_visit_cancellation_billing('d1500000-0000-0000-0000-000000000002',(select id from visit_cancellations where job_id='d1500000-0000-0000-0000-000000000002'));
select pg_sleep(2);
commit;
SQL
CANCEL_PID=$!
cancel_barrier cancel_resolve_first
cancel_sql <<'SQL'
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000002',false);
set role authenticated;
select resolve_visit_cancellation_billing('d1500000-0000-0000-0000-000000000002',(select id from visit_cancellations where job_id='d1500000-0000-0000-0000-000000000002'));
SQL
wait "$CANCEL_PID"
# A review expires while waiting for the job; actual time must be rechecked.
PGAPPNAME=cancel_expiry_first cancel_sql >"$CANCEL_DIR/expiry" <<'SQL' &
begin;
select id from jobs where id='d1500000-0000-0000-0000-000000000004' for update;
update visit_cancellation_quotes set expires_at=clock_timestamp()+interval '1 second' where job_id='d1500000-0000-0000-0000-000000000004';
select pg_sleep(2);
commit;
SQL
CANCEL_PID=$!
cancel_barrier cancel_expiry_first
cancel_sql <<'SQL'
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',false);
set role authenticated;
do $$ begin begin
 perform confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000004',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000004'));
 raise exception 'Expired cancellation saved after wait';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$CANCEL_PID"
# Genuine engine serialization failures remain whole-transaction retries.
PGAPPNAME=cancel_rr_reader cancel_sql >"$CANCEL_DIR/rr" 2>&1 <<'SQL' &
begin isolation level repeatable read;
select count(*) from jobs;
select pg_sleep(2);
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000005',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000005'));
commit;
SQL
CANCEL_PID=$!
cancel_barrier cancel_rr_reader
cancel_sql <<'SQL'
select set_config('request.jwt.claim.sub','d1100000-0000-0000-0000-000000000001',false);
set role authenticated;
select confirm_my_visit_cancellation('d1500000-0000-0000-0000-000000000005',(select id from visit_cancellation_quotes where job_id='d1500000-0000-0000-0000-000000000005'));
SQL
if wait "$CANCEL_PID";then echo 'Stale cancellation transaction did not abort' >&2;exit 1;fi
if ! grep -q 'could not serialize access due to concurrent update' "$CANCEL_DIR/rr";then cat "$CANCEL_DIR/rr";exit 1;fi
cancel_sql <<'SQL'
do $$ declare c record;begin
 if (select count(*) from visit_cancellations where job_id::text like 'd1500000-%')<>4 then raise exception 'Cancellation receipt duplicated or expired review saved';end if;
 if (select status from jobs where id='d1500000-0000-0000-0000-000000000004')<>'scheduled' then raise exception 'Expired review changed visit';end if;
 if exists(select 1 from invoices where id::text like 'd1700000-%' and job_id<>'d1500000-0000-0000-0000-000000000004' and status<>'void') then raise exception 'Original clean remains collectible';end if;
 for c in select * from visit_cancellations where job_id::text like 'd1500000-%' loop
  if c.billing_review or c.fee_cents<>6000 or c.invoice_id is null then raise exception 'Fee receipt incomplete';end if;
  if (select count(*) from invoices where job_id=c.job_id and voided_at is null)<>1 then raise exception 'Fee obligation duplicated';end if;
  if not exists(select 1 from invoices where id=c.invoice_id and total_cents=6000 and amount_paid_cents=0 and autocharge_paused_at is not null and next_attempt_at is null) then raise exception 'Fee lost explicit checkout boundary';end if;
  begin perform begin_payment_operation(c.invoice_id,'autocharge','cancel-race-auto-'||c.id,6000,900);raise exception 'Fee autocharged under clean consent';exception when check_violation then null;end;
  perform begin_payment_operation(c.invoice_id,'checkout','cancel-race-checkout-'||c.id,6000,900);
 end loop;
 if exists(select 1 from payments where customer_id='d1200000-0000-0000-0000-000000000001') then raise exception 'Payment invented';end if;
 raise notice 'Cancellation collection races passed: cancellation first, collection first, confirmation retry, reconciliation retry, actual expiry and repeatable-read retry';
end $$;
SQL
