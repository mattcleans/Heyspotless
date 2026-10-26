#!/usr/bin/env bash
# Disposable CI database only. No provider, issuance or real payment calls.
set -euo pipefail
DRAFT_DB="${1:?pass disposable verifier database}"
[[ "$DRAFT_DB" == spotless_verify* ]] || { echo 'A disposable verifier database is required.' >&2; exit 1; }
DRAFT_DIR=$(mktemp -d)
DRAFT_FIRST=''
DRAFT_SECOND=''
draft_cleanup() {
  local draft_exit=$?
  for draft_pid in "$DRAFT_FIRST" "$DRAFT_SECOND"; do [ -z "$draft_pid" ] || kill "$draft_pid" 2>/dev/null || true; done
  if [ "$draft_exit" -ne 0 ]; then for draft_log in "$DRAFT_DIR"/*.log; do [ ! -f "$draft_log" ] || cat "$draft_log" >&2; done; fi
  rm -rf "$DRAFT_DIR"
}
trap draft_cleanup EXIT
draft_sql() { PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=15000 -c lock_timeout=10000" psql -X -v ON_ERROR_STOP=1 -q -d "$DRAFT_DB" "$@"; }
draft_observe() {
  local draft_query="$1"
  for _ in $(seq 1 100); do
    if [ "$(draft_sql -tAc "$draft_query")" = 1 ]; then return; fi
    sleep .05
  done
  echo 'Expected draft lock overlap was not observed.' >&2; return 1
}
draft_race() {
  local draft_case="$1"
  { echo 'begin;'; cat "$DRAFT_DIR/$draft_case-first.sql"; echo 'select pg_sleep(4);commit;'; } |
    PGAPPNAME="draft_${draft_case}_first" draft_sql >"$DRAFT_DIR/$draft_case-first.log" 2>&1 &
  DRAFT_FIRST=$!
  draft_observe "select count(*) from pg_stat_activity where datname=current_database() and application_name='draft_${draft_case}_first' and wait_event='PgSleep'"
  { echo 'begin;set local role service_role;'; cat "$DRAFT_DIR/$draft_case-second.sql"; echo 'commit;'; } |
    PGAPPNAME="draft_${draft_case}_second" draft_sql >"$DRAFT_DIR/$draft_case-second.log" 2>&1 &
  DRAFT_SECOND=$!
  draft_observe "select count(*) from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.datname=current_database() and w.application_name='draft_${draft_case}_second' and h.application_name='draft_${draft_case}_first' and w.wait_event_type='Lock'"
  wait "$DRAFT_FIRST";DRAFT_FIRST=''
  wait "$DRAFT_SECOND";DRAFT_SECOND=''
}
draft_sql <<'SQL'
insert into public.customers(id,first_name,last_name) values('f4100000-0000-4000-8000-000000000001','SYNTHETIC','Draft concurrency');
insert into public.properties(id,customer_id,street,city,zip,bedrooms,bathrooms,utility_rooms) values('f4200000-0000-4000-8000-000000000001','f4100000-0000-4000-8000-000000000001','SYNTHETIC ONLY','Dallas','75201',1,1,0);
insert into public.cleaners(id,full_name,type,status,profile_published) values('f4300000-0000-4000-8000-000000000001','SYNTHETIC draft concurrency','contractor_1099','active',false);
insert into public.jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at) values('f4400000-0000-4000-8000-000000000001','f4100000-0000-4000-8000-000000000001','f4200000-0000-4000-8000-000000000001','complete','standard','one_time',19900,120,now());
insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values('f4400000-0000-4000-8000-000000000001','f4300000-0000-4000-8000-000000000001',true,6965);
insert into storage.objects(bucket_id,name)
 select 'job-photos','jobs/f4400000-0000-4000-8000-000000000001/'||room||'-'||kind||'.jpg' from unnest(array['kitchen_1','bathroom_1','living_room_1','bedroom_1'])room cross join unnest(array['before','after'])kind;
insert into public.job_photos(job_id,cleaner_id,storage_path,room_key,kind)
 select 'f4400000-0000-4000-8000-000000000001','f4300000-0000-4000-8000-000000000001','jobs/f4400000-0000-4000-8000-000000000001/'||room||'-'||kind||'.jpg',room,kind from unnest(array['kitchen_1','bathroom_1','living_room_1','bedroom_1'])room cross join unnest(array['before','after'])kind;
SQL
cat >"$DRAFT_DIR/price-first.sql" <<'SQL'
update public.jobs set price_cents=20900 where id='f4400000-0000-4000-8000-000000000001';
SQL
cat >"$DRAFT_DIR/price-second.sql" <<'SQL'
do $$ begin
 begin perform public.prepare_job_service_draft('f4400000-0000-4000-8000-000000000001',19900);raise exception 'Price changed during lock wait but draft succeeded';exception when sqlstate 'PFD01' then null;end;
end $$;
SQL
draft_race price
draft_sql <<'SQL'
do $$ begin if exists(select 1 from public.invoices where job_id='f4400000-0000-4000-8000-000000000001') then raise exception 'Stale review left a draft';end if;end $$;
update public.jobs set price_cents=19900 where id='f4400000-0000-4000-8000-000000000001';
SQL
cat >"$DRAFT_DIR/receipt-first.sql" <<'SQL'
set local role service_role;
do $$ begin if public.prepare_job_service_draft('f4400000-0000-4000-8000-000000000001',19900) is null then raise exception 'First draft receipt missing';end if;end $$;
SQL
cp "$DRAFT_DIR/receipt-first.sql" "$DRAFT_DIR/receipt-second.sql"
draft_race receipt
draft_sql <<'SQL'
do $$ begin
 if (select count(*) from public.invoices where job_id='f4400000-0000-4000-8000-000000000001')<>1 or not exists(select 1 from public.invoices where job_id='f4400000-0000-4000-8000-000000000001' and status='draft' and total_cents=19900 and issued_at is null and amount_paid_cents=0) then raise exception 'Concurrent preparation lost, duplicated or issued the service draft';end if;
 raise notice 'Management draft races passed: price changed during an observed lock wait is rejected; simultaneous preparations share one unissued draft.';
end $$;
SQL
