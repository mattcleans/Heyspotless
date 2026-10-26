#!/usr/bin/env bash
# Disposable verifier database only. No Stripe calls or actual payout transfers.
set -euo pipefail
FEEDBACK_DB="${1:?pass disposable verifier database}"
if [[ "$FEEDBACK_DB" != spotless_verify* ]]; then
  echo 'Feedback race fixtures require a spotless_verify database.' >&2
  exit 1
fi
FEEDBACK_DIR=$(mktemp -d)
FEEDBACK_FIRST_PID=''
FEEDBACK_SECOND_PID=''
feedback_cleanup() {
  local feedback_exit=$?
  for feedback_pid in "$FEEDBACK_FIRST_PID" "$FEEDBACK_SECOND_PID"; do
    if [ -n "$feedback_pid" ]; then kill "$feedback_pid" 2>/dev/null || true; fi
  done
  if [ "$feedback_exit" -ne 0 ]; then
    for feedback_log in "$FEEDBACK_DIR"/*.log; do
      [ ! -f "$feedback_log" ] || cat "$feedback_log" >&2
    done
  fi
  rm -rf "$FEEDBACK_DIR"
}
trap feedback_cleanup EXIT
feedback_sql() {
  PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=15000 -c lock_timeout=10000" \
    psql -X -v ON_ERROR_STOP=1 -q -d "$FEEDBACK_DB" "$@"
}
feedback_barrier() {
  local feedback_name="$1" feedback_seen
  for _ in $(seq 1 100); do
    feedback_seen=$(feedback_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$feedback_name' and wait_event='PgSleep'")
    if [ "$feedback_seen" = 1 ]; then return; fi
    sleep .05
  done
  echo "Feedback race missed the first transaction barrier: $feedback_name" >&2
  return 1
}
feedback_blocked() {
  local feedback_waiter="$1" feedback_holder="$2" feedback_seen
  for _ in $(seq 1 100); do
    feedback_seen=$(feedback_sql -tAc "select count(*) from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.datname=current_database() and w.application_name='$feedback_waiter' and h.application_name='$feedback_holder' and w.wait_event_type='Lock'")
    if [ "$feedback_seen" = 1 ]; then return; fi
    sleep .05
  done
  echo "Feedback requests did not overlap on the expected lock: $feedback_waiter / $feedback_holder" >&2
  return 1
}
feedback_race() {
  local feedback_case="$1"
  {
    echo 'begin; set local role service_role;'
    cat "$FEEDBACK_DIR/$feedback_case-first.sql"
    echo 'select pg_sleep(4); commit;'
  } | PGAPPNAME="feedback_${feedback_case}_first" feedback_sql >"$FEEDBACK_DIR/$feedback_case-first.log" 2>&1 &
  FEEDBACK_FIRST_PID=$!
  feedback_barrier "feedback_${feedback_case}_first"
  {
    echo 'begin; set local role service_role;'
    cat "$FEEDBACK_DIR/$feedback_case-second.sql"
    echo 'commit;'
  } | PGAPPNAME="feedback_${feedback_case}_second" feedback_sql >"$FEEDBACK_DIR/$feedback_case-second.log" 2>&1 &
  FEEDBACK_SECOND_PID=$!
  feedback_blocked "feedback_${feedback_case}_second" "feedback_${feedback_case}_first"
  wait "$FEEDBACK_FIRST_PID"
  FEEDBACK_FIRST_PID=''
  wait "$FEEDBACK_SECOND_PID"
  FEEDBACK_SECOND_PID=''
}

feedback_sql <<'SQL'
-- Model the hosted service role's narrow table access used by the local
-- settlement fixtures. Application feedback still uses service-only RPCs.
grant usage on schema public to service_role;
grant select(job_id),update(paid_at) on payouts to service_role;
insert into auth.users(id,email) values
 ('e2100000-0000-4000-8000-000000000001','feedback-race-client@example.test'),
 ('e2100000-0000-4000-8000-000000000002','feedback-race-other@example.test');
insert into customers(id,profile_id,first_name,last_name)
 select ('e2200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('e2100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC feedback race','Client' from generate_series(1,2)n;
insert into properties(id,customer_id,street,city,zip)
 select ('e2300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('e2200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC verifier only','Dallas','75201' from generate_series(1,2)n;
insert into cleaners(id,full_name,type,status,rating,background_check_cleared,profile_published)
 select ('e2400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'SYNTHETIC feedback race '||n,'contractor_1099','paused',4.8,true,false from generate_series(1,10)n;
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at,notes)
 select ('e2500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=7 then 'e2200000-0000-4000-8000-000000000002'::uuid else 'e2200000-0000-4000-8000-000000000001'::uuid end,
 case when n=7 then 'e2300000-0000-4000-8000-000000000002'::uuid else 'e2300000-0000-4000-8000-000000000001'::uuid end,
 'complete','standard','one_time',20000,120,now(),'SYNTHETIC CI concurrency fixture; no actual service or transfer.' from generate_series(1,10)n;
insert into job_assignments(job_id,cleaner_id,is_lead,payout_cents)
 select ('e2500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('e2400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,6600 from generate_series(1,10)n;
insert into invoices(id,customer_id,job_id,status,subtotal_cents,total_cents,due_on)
 select ('e2700000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=7 then 'e2200000-0000-4000-8000-000000000002'::uuid else 'e2200000-0000-4000-8000-000000000001'::uuid end,
 ('e2500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'sent',20000,20000,business_today()+7 from generate_series(1,10)n;
insert into payouts(job_id,cleaner_id,amount_cents)
 select ('e2500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('e2400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,6600 from generate_series(1,10)n;
SQL

# Two clients waiting on the same submission must recover one durable receipt.
cat >"$FEEDBACK_DIR/duplicate-first.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000001',5,null,array['thorough'],'SYNTHETIC duplicate',2000);
SQL
cat >"$FEEDBACK_DIR/duplicate-second.sql" <<'SQL'
do $$ declare r jsonb; begin
 r:=record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000001',5,null,array['thorough'],'SYNTHETIC duplicate',2000);
 if r is distinct from '{"recorded":true,"tip":{"tipCents":2000,"feeCents":58,"netCents":1942}}'::jsonb then raise exception 'Concurrent duplicate lost the original receipt'; end if;
end $$;
SQL
feedback_race duplicate

# Different submissions serialize on the visit; a lost older response cannot
# subsequently restore the first amount over the newer committed request.
cat >"$FEEDBACK_DIR/edit-first.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000002',4,null,'{}','SYNTHETIC older edit',3000);
SQL
cat >"$FEEDBACK_DIR/edit-second.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000003','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000002',5,null,array['on_time'],'SYNTHETIC newer edit',4000);
SQL
feedback_race edit
feedback_sql -f "$FEEDBACK_DIR/edit-first.sql"

# A collector already holding the invoice keeps its amount; the rating is
# saved while the attempted tip is rejected, without changing either ledger.
cat >"$FEEDBACK_DIR/collection-first.sql" <<'SQL'
select * from begin_payment_operation('e2700000-0000-4000-8000-000000000003','checkout','SYNTHETIC-feedback-race-open',20000,900);
SQL
cat >"$FEEDBACK_DIR/collection-second.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000004','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000003',5,null,'{}','SYNTHETIC collection race rating survives',2000);
SQL
feedback_race collection

# Settlement can win the payout row after feedback has locked the visit and
# invoice. The guarded upsert must roll back the invoice tip as well.
cat >"$FEEDBACK_DIR/settlement-first.sql" <<'SQL'
update payouts set paid_at=clock_timestamp() where job_id='e2500000-0000-4000-8000-000000000004';
SQL
cat >"$FEEDBACK_DIR/settlement-second.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000005','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000004',4,null,'{}','SYNTHETIC settlement race rating survives',2000);
SQL
feedback_race settlement

# Feedback can win first, in which case the settlement sees the committed tip
# split along with the work payout. No amount can appear only after settlement.
cat >"$FEEDBACK_DIR/tipfirst-first.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000006','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000005',5,null,'{}','SYNTHETIC tip before settlement',2500);
SQL
cat >"$FEEDBACK_DIR/tipfirst-second.sql" <<'SQL'
update payouts set paid_at=clock_timestamp() where job_id='e2500000-0000-4000-8000-000000000005';
SQL
feedback_race tipfirst

# A simultaneous request for another owned visit/actor cannot steal a globally
# unique submission ID. This checks the advisory lock across different jobs.
cat >"$FEEDBACK_DIR/identity-first.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000007','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000006',5,null,'{}','SYNTHETIC original identity',1500);
SQL
cat >"$FEEDBACK_DIR/identity-second.sql" <<'SQL'
do $$ begin
 begin
  perform record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000007','e2100000-0000-4000-8000-000000000002','e2500000-0000-4000-8000-000000000007',1,null,'{}','SYNTHETIC conflicting identity',1000);
  raise exception 'Concurrent request stole another submission identity';
 exception when insufficient_privilege then null; end;
end $$;
SQL
feedback_race identity

# A reviewed checkout must reject a balance/owner that changes while its
# invoice claim waits. These are fixture ledger edits, not provider outcomes.
cat >"$FEEDBACK_DIR/tipclaim-first.sql" <<'SQL'
select record_client_visit_feedback_once('e2600000-0000-4000-8000-000000000008','e2100000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000008',5,null,'{}','SYNTHETIC tip before checkout claim',2000);
SQL
cat >"$FEEDBACK_DIR/tipclaim-second.sql" <<'SQL'
do $$ begin
 begin
  perform begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000008','checkout','SYNTHETIC-stale-tip-claim',20000,20000,'e2200000-0000-4000-8000-000000000001');
  raise exception 'Claim collected the pre-tip balance after a real lock wait';
 exception when sqlstate 'PT409' then null; end;
end $$;
SQL
feedback_race tipclaim
feedback_sql <<'SQL'
select * from begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000008','checkout','SYNTHETIC-refreshed-tip-claim',22000,22000,'e2200000-0000-4000-8000-000000000001');
SQL
cat >"$FEEDBACK_DIR/creditclaim-first.sql" <<'SQL'
reset role;
update invoices set credit_cents=2000 where id='e2700000-0000-4000-8000-000000000009';
SQL
cat >"$FEEDBACK_DIR/creditclaim-second.sql" <<'SQL'
do $$ begin
 begin
  perform begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000009','autocharge','SYNTHETIC-stale-credit-claim',20000,20000,'e2200000-0000-4000-8000-000000000001');
  raise exception 'Sweep collected the pre-credit balance after a real lock wait';
 exception when sqlstate 'PT409' then null; end;
end $$;
SQL
feedback_race creditclaim
cat >"$FEEDBACK_DIR/ownerclaim-first.sql" <<'SQL'
reset role;
update invoices set customer_id='e2200000-0000-4000-8000-000000000002' where id='e2700000-0000-4000-8000-000000000010';
SQL
cat >"$FEEDBACK_DIR/ownerclaim-second.sql" <<'SQL'
do $$ begin
 begin
  perform begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000010','checkout','SYNTHETIC-stale-owner-claim',20000,20000,'e2200000-0000-4000-8000-000000000001');
  raise exception 'Claim ignored a changed Client after a real lock wait';
 exception when sqlstate 'PT409' then null; end;
end $$;
SQL
feedback_race ownerclaim

# Two retrying tabs use one fresh server generation after a confirmed terminal
# Checkout. Replaying the finished provider key must not trap either tab.
feedback_sql <<'SQL'
select * from begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000009','checkout','SYNTHETIC-retry-race',18000,18000,'e2200000-0000-4000-8000-000000000001');
select resolve_payment_operation('SYNTHETIC-retry-race','failed','SYNTHETIC provider confirmed terminal');
SQL
cat >"$FEEDBACK_DIR/retrykey-first.sql" <<'SQL'
do $$ declare r record; begin
 select * into r from begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000009','checkout','SYNTHETIC-retry-race',18000,18000,'e2200000-0000-4000-8000-000000000001');
 if r.outcome is distinct from 'started' or r.idempotency_key<>'SYNTHETIC-retry-race:retry:1' then raise exception 'Fresh retry reused a finished key'; end if;
end $$;
SQL
cat >"$FEEDBACK_DIR/retrykey-second.sql" <<'SQL'
do $$ declare r record; begin
 select * into r from begin_reviewed_payment_operation('e2700000-0000-4000-8000-000000000009','checkout','SYNTHETIC-retry-race',18000,18000,'e2200000-0000-4000-8000-000000000001');
 if r.outcome is distinct from 'existing' or r.idempotency_key<>'SYNTHETIC-retry-race:retry:1' then raise exception 'Concurrent retry generated a second key'; end if;
end $$;
SQL
feedback_race retrykey

feedback_sql <<'SQL'
do $$ declare j record; expected integer; receipt jsonb; begin
 for j in select id from jobs where id between 'e2500000-0000-4000-8000-000000000001' and 'e2500000-0000-4000-8000-000000000007' order by id loop
  expected:=case right(j.id::text,1) when '1' then 2000 when '2' then 4000 when '5' then 2500 when '6' then 1500 else 0 end;
  if not exists(select 1 from invoices where job_id=j.id and tip_cents=expected and total_cents=20000+expected and amount_paid_cents=0)
   or not exists(select 1 from payouts where job_id=j.id and amount_cents=6600 and tip_cents=expected and tip_fee_cents=floor(expected*.029) and tip_net_cents=expected-floor(expected*.029)) then raise exception 'Concurrent invoice/payout amounts diverged for %',j.id; end if;
  if (select count(*) from payouts where job_id=j.id)<>1 then raise exception 'Concurrent tip duplicated payout'; end if;
  if right(j.id::text,1)='7' then
   if exists(select 1 from ratings where job_id=j.id) or exists(select 1 from spotless_private.client_feedback_receipts where job_id=j.id) then raise exception 'Conflicting actor saved feedback'; end if;
  elsif (select count(*) from ratings where job_id=j.id)<>1 then raise exception 'Concurrent rating was duplicated or lost'; end if;
 end loop;
 if (select count(*) from spotless_private.client_feedback_receipts where job_id between 'e2500000-0000-4000-8000-000000000001' and 'e2500000-0000-4000-8000-000000000007')<>7 then raise exception 'Concurrent submissions duplicated or lost receipts'; end if;
 if exists(select 1 from spotless_private.client_feedback_receipts where job_id::text like 'e2500000-%' and (result->>'recorded') is distinct from 'true') then raise exception 'Recorded submission lacks rating success'; end if;
 if not exists(select 1 from ratings where job_id='e2500000-0000-4000-8000-000000000002' and score=5 and private_note='SYNTHETIC newer edit') then raise exception 'Older replay overwrote newer rating'; end if;
 select result into receipt from spotless_private.client_feedback_receipts where id='e2600000-0000-4000-8000-000000000004';
 if (receipt->>'recorded') is distinct from 'true' or (receipt->>'tipError') is distinct from 'tip_payment_in_progress' then raise exception 'Collection race lost rating or changed amount'; end if;
 select result into receipt from spotless_private.client_feedback_receipts where id='e2600000-0000-4000-8000-000000000005';
 if (receipt->>'recorded') is distinct from 'true' or (receipt->>'tipError') is distinct from 'tip_settled_review' then raise exception 'Settlement race did not preserve partial success'; end if;
 if (select count(*) from payouts where job_id::text like 'e2500000-%' and paid_at is not null)<>2 then raise exception 'Fixture settlements were lost'; end if;
 if not exists(select 1 from payment_operations where idempotency_key='SYNTHETIC-feedback-race-open' and state='open' and amount_cents=20000) then raise exception 'In-flight operation was changed'; end if;
 if exists(select 1 from payments where customer_id::text like 'e2200000-%') then raise exception 'Feedback fixture invented a payment'; end if;
 if exists(select 1 from payment_operations where idempotency_key in ('SYNTHETIC-stale-tip-claim','SYNTHETIC-stale-credit-claim','SYNTHETIC-stale-owner-claim')) then raise exception 'Rejected reviewed claim left an attempt'; end if;
 if not exists(select 1 from payment_operations where idempotency_key='SYNTHETIC-refreshed-tip-claim' and amount_cents=22000 and state='open') then raise exception 'Refreshed current balance did not recover'; end if;
 if not exists(select 1 from invoices where id='e2700000-0000-4000-8000-000000000008' and balance_cents=22000 and tip_cents=2000)
  or not exists(select 1 from payouts where job_id='e2500000-0000-4000-8000-000000000008' and tip_cents=2000 and tip_net_cents=1942) then raise exception 'Reviewed collection disturbed the saved tip'; end if;
 if not exists(select 1 from invoices where id='e2700000-0000-4000-8000-000000000009' and balance_cents=18000 and credit_cents=2000) then raise exception 'Reviewed collection disturbed credit'; end if;
 if not exists(select 1 from invoices where id='e2700000-0000-4000-8000-000000000010' and customer_id='e2200000-0000-4000-8000-000000000002') then raise exception 'Reviewed collection disturbed ownership'; end if;
 if (select count(*) from payment_operations where invoice_id='e2700000-0000-4000-8000-000000000009')<>2
  or not exists(select 1 from payment_operations where idempotency_key='SYNTHETIC-retry-race:retry:1' and state='open' and amount_cents=18000) then raise exception 'Concurrent retry duplicated or lost its operation'; end if;
 raise notice 'Terminal Checkout retry race passed: simultaneous tabs share one fresh provider key after the confirmed prior outcome.';
 raise notice 'Reviewed collection races passed: tip, credit and Client changes during actual invoice lock waits reject stale claims; refreshed balance recovers without a duplicate operation.';
 raise notice 'Client feedback races passed: same submission, newer edit and older replay, collection first, payout settlement first, tip first and cross-Client identity collision. Every competing connection was observed waiting on its holder.';
end $$;
SQL
