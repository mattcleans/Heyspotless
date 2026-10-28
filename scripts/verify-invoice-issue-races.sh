#!/usr/bin/env bash
# Disposable CI database only. Synthetic invoice issuance; no provider or payment calls.
set -euo pipefail
ISSUE_DB="${1:?pass disposable verifier database}"
[[ "$ISSUE_DB" == spotless_verify* ]] || { echo 'A disposable verifier database is required.' >&2; exit 1; }
ISSUE_DIR=$(mktemp -d)
ISSUE_FIRST=''
ISSUE_SECOND=''
issue_cleanup() {
  local issue_exit=$?
  for issue_pid in "$ISSUE_FIRST" "$ISSUE_SECOND"; do [ -z "$issue_pid" ] || kill "$issue_pid" 2>/dev/null || true; done
  if [ "$issue_exit" -ne 0 ]; then for issue_log in "$ISSUE_DIR"/*.log; do [ ! -f "$issue_log" ] || cat "$issue_log" >&2; done; fi
  rm -rf "$ISSUE_DIR"
}
trap issue_cleanup EXIT
issue_sql() { PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=15000 -c lock_timeout=10000" psql -X -v ON_ERROR_STOP=1 -q -d "$ISSUE_DB" "$@"; }
issue_observe() {
  local issue_query="$1"
  for _ in $(seq 1 100); do
    if [ "$(issue_sql -tAc "$issue_query")" = 1 ]; then return; fi
    sleep .05
  done
  echo 'Expected issuance lock overlap was not observed.' >&2; return 1
}
issue_race() {
  local issue_case="$1"
  { echo 'begin;'; cat "$ISSUE_DIR/$issue_case-first.sql"; echo 'select pg_sleep(4);commit;'; } |
    PGAPPNAME="issue_${issue_case}_first" issue_sql >"$ISSUE_DIR/$issue_case-first.log" 2>&1 &
  ISSUE_FIRST=$!
  issue_observe "select count(*) from pg_stat_activity where datname=current_database() and application_name='issue_${issue_case}_first' and wait_event='PgSleep'"
  { echo 'begin;set local role service_role;'; cat "$ISSUE_DIR/$issue_case-second.sql"; echo 'commit;'; } |
    PGAPPNAME="issue_${issue_case}_second" issue_sql >"$ISSUE_DIR/$issue_case-second.log" 2>&1 &
  ISSUE_SECOND=$!
  issue_observe "select count(*) from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.datname=current_database() and w.application_name='issue_${issue_case}_second' and h.application_name='issue_${issue_case}_first' and w.wait_event_type='Lock'"
  wait "$ISSUE_FIRST";ISSUE_FIRST=''
  wait "$ISSUE_SECOND";ISSUE_SECOND=''
}
issue_sql <<'SQL'
insert into auth.users(id,email) values('f5100000-0000-4000-8000-000000000001','SYNTHETIC-issue-race@example.test');
update public.profiles set role='admin' where id='f5100000-0000-4000-8000-000000000001';
insert into public.customers(id,first_name,last_name) values('f5200000-0000-4000-8000-000000000001','SYNTHETIC','Issuance concurrency');
insert into public.properties(id,customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms) values('f5300000-0000-4000-8000-000000000001','f5200000-0000-4000-8000-000000000001','SYNTHETIC ONLY','Dallas','75201',1,1,0,1,0,0);
insert into public.cleaners(id,full_name,type,status,profile_published) values('f5400000-0000-4000-8000-000000000001','SYNTHETIC issuance concurrency','contractor_1099','active',false);
insert into public.jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at) values('f5500000-0000-4000-8000-000000000001','f5200000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000001','complete','standard','one_time',19900,120,now());
insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values('f5500000-0000-4000-8000-000000000001','f5400000-0000-4000-8000-000000000001',true,6965);
insert into public.invoices(id,job_id,customer_id,status,kind,subtotal_cents,total_cents) values('f5600000-0000-4000-8000-000000000001','f5500000-0000-4000-8000-000000000001','f5200000-0000-4000-8000-000000000001','draft','service',19900,19900);
insert into storage.objects(bucket_id,name)
 select 'job-photos','jobs/f5500000-0000-4000-8000-000000000001/'||room||'-'||kind||'.jpg' from unnest(array['kitchen_1','bathroom_1','bedroom_1'])room cross join unnest(array['before','after'])kind;
insert into public.job_photos(job_id,cleaner_id,storage_path,room_key,kind)
 select 'f5500000-0000-4000-8000-000000000001','f5400000-0000-4000-8000-000000000001','jobs/f5500000-0000-4000-8000-000000000001/'||room||'-'||kind||'.jpg',room,kind from unnest(array['kitchen_1','bathroom_1','bedroom_1'])room cross join unnest(array['before','after'])kind;
SQL
cat >"$ISSUE_DIR/price-first.sql" <<'SQL'
select 1 from public.jobs where id='f5500000-0000-4000-8000-000000000001' for update;
update public.invoices set total_cents=20900,subtotal_cents=20900 where id='f5600000-0000-4000-8000-000000000001';
SQL
cat >"$ISSUE_DIR/price-second.sql" <<'SQL'
do $$ begin
 begin perform public.issue_reviewed_service_invoice('f5500000-0000-4000-8000-000000000001','f5600000-0000-4000-8000-000000000001','f5100000-0000-4000-8000-000000000001',19900,(clock_timestamp() at time zone 'America/Chicago')::date+7);raise exception 'Stale total accepted after issuance lock wait';exception when sqlstate 'PIS01' then null;end;
end $$;
SQL
issue_race price
issue_sql <<'SQL'
do $$ begin if exists(select 1 from spotless_private.service_invoice_issuances where invoice_id='f5600000-0000-4000-8000-000000000001') or not exists(select 1 from public.invoices where id='f5600000-0000-4000-8000-000000000001' and status='draft' and issued_at is null) then raise exception 'Rejected stale review issued the invoice';end if;end $$;
update public.invoices set total_cents=19900,subtotal_cents=19900 where id='f5600000-0000-4000-8000-000000000001';
SQL
cat >"$ISSUE_DIR/receipt-first.sql" <<'SQL'
set local role service_role;
do $$ declare r jsonb;begin
 r:=public.issue_reviewed_service_invoice('f5500000-0000-4000-8000-000000000001','f5600000-0000-4000-8000-000000000001','f5100000-0000-4000-8000-000000000001',19900,(clock_timestamp() at time zone 'America/Chicago')::date+7);
 if r->>'issued' is distinct from 'true' then raise exception 'Issuance receipt missing';end if;
end $$;
SQL
cp "$ISSUE_DIR/receipt-first.sql" "$ISSUE_DIR/receipt-second.sql"
issue_race receipt
issue_sql <<'SQL'
do $$ begin
 if (select count(*) from spotless_private.service_invoice_issuances where invoice_id='f5600000-0000-4000-8000-000000000001')<>1 or not exists(select 1 from public.invoices i join spotless_private.service_invoice_issuances r on r.invoice_id=i.id where i.id='f5600000-0000-4000-8000-000000000001' and i.status='sent' and i.total_cents=19900 and i.issued_at=r.issued_at and i.due_on=r.due_on and i.amount_paid_cents=0 and i.next_attempt_at is null) or exists(select 1 from public.payments where customer_id='f5200000-0000-4000-8000-000000000001') then raise exception 'Concurrent issuance lost its receipt, changed the bill or recorded collection';end if;
 raise notice 'Issuance races passed: a total changed during an observed lock wait is rejected; simultaneous issuers share one receipt and timestamp without collection.';
end $$;
SQL
