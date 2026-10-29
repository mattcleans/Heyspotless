#!/usr/bin/env bash
# Disposable CI database only. Synthetic photo metadata; no provider or payment calls.
set -euo pipefail
CAPTURE_DB="${1:?pass disposable verifier database}"
[[ "$CAPTURE_DB" == spotless_verify* ]] || { echo 'A disposable verifier database is required.' >&2; exit 1; }
CAPTURE_DIR=$(mktemp -d)
CAPTURE_FIRST=''
CAPTURE_SECOND=''
capture_cleanup() {
  local capture_exit=$?
  for capture_pid in "$CAPTURE_FIRST" "$CAPTURE_SECOND"; do [ -z "$capture_pid" ] || kill "$capture_pid" 2>/dev/null || true; done
  if [ "$capture_exit" -ne 0 ]; then for capture_log in "$CAPTURE_DIR"/*.log; do [ ! -f "$capture_log" ] || cat "$capture_log" >&2; done; fi
  rm -rf "$CAPTURE_DIR"
}
trap capture_cleanup EXIT
capture_sql() { PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=15000 -c lock_timeout=10000" psql -X -v ON_ERROR_STOP=1 -q -d "$CAPTURE_DB" "$@"; }
capture_observe() {
  local capture_query="$1"
  for _ in $(seq 1 100); do
    if [ "$(capture_sql -tAc "$capture_query")" = 1 ]; then return; fi
    sleep .05
  done
  echo 'Expected capture lock overlap was not observed.' >&2; return 1
}
capture_race() {
  local capture_case="$1"
  { echo 'begin;'; cat "$CAPTURE_DIR/$capture_case-first.sql"; echo 'select pg_sleep(4);commit;'; } |
    PGAPPNAME="capture_${capture_case}_first" capture_sql >"$CAPTURE_DIR/$capture_case-first.log" 2>&1 &
  CAPTURE_FIRST=$!
  capture_observe "select count(*) from pg_stat_activity where datname=current_database() and application_name='capture_${capture_case}_first' and wait_event='PgSleep'"
  { echo 'begin;set local role service_role;'; cat "$CAPTURE_DIR/$capture_case-second.sql"; echo 'commit;'; } |
    PGAPPNAME="capture_${capture_case}_second" capture_sql >"$CAPTURE_DIR/$capture_case-second.log" 2>&1 &
  CAPTURE_SECOND=$!
  capture_observe "select count(*) from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.datname=current_database() and w.application_name='capture_${capture_case}_second' and h.application_name='capture_${capture_case}_first' and w.wait_event_type='Lock'"
  wait "$CAPTURE_FIRST";CAPTURE_FIRST=''
  wait "$CAPTURE_SECOND";CAPTURE_SECOND=''
}
capture_sql <<'SQL'
alter table storage.objects add column if not exists version text default gen_random_uuid()::text;
alter table storage.objects add column if not exists metadata jsonb default '{"size":3}'::jsonb;
insert into public.customers(id,first_name,last_name) values('f6200000-0000-4000-8000-000000000001','SYNTHETIC','Capture races');
insert into public.properties(id,customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms) values('f6300000-0000-4000-8000-000000000001','f6200000-0000-4000-8000-000000000001','SYNTHETIC ONLY','Dallas','75201',1,1,0,1,0,0);
insert into public.cleaners(id,full_name,type,status,profile_published) values('f6400000-0000-4000-8000-000000000001','SYNTHETIC capture races','contractor_1099','active',false);
insert into public.jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes) values('f6500000-0000-4000-8000-000000000001','f6200000-0000-4000-8000-000000000001','f6300000-0000-4000-8000-000000000001','in_progress','standard','one_time',19900,120);
insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001',true,6965);
insert into storage.objects(id,bucket_id,name,version,metadata) values('f6700000-0000-4000-8000-000000000001','job-photos','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000001.jpg','object-v1','{"size":3}');
insert into storage.objects(id,bucket_id,name,version,metadata) values('f6700000-0000-4000-8000-000000000002','job-photos','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000002.jpg','object-v2','{"size":3}');
insert into storage.objects(id,bucket_id,name,version,metadata) values('f6700000-0000-4000-8000-000000000003','job-photos','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000003.jpg','object-v3','{"size":3}');
set role service_role;select public.record_job_photo_capture('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000001.jpg','kitchen_1','before','f6600000-0000-4000-8000-000000000001',repeat('a',64),'{}','f6700000-0000-4000-8000-000000000001','object-v1',3);reset role;
SQL
cat >"$CAPTURE_DIR/newer-first.sql" <<'SQL'
set local role service_role;select public.record_job_photo_capture('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000002.jpg','kitchen_1','before','f6600000-0000-4000-8000-000000000002',repeat('b',64),array['f6600000-0000-4000-8000-000000000001'::uuid],'f6700000-0000-4000-8000-000000000002','object-v2',3);
SQL
cat >"$CAPTURE_DIR/newer-second.sql" <<'SQL'
do $$ begin begin perform public.record_job_photo_capture('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000003.jpg','kitchen_1','before','f6600000-0000-4000-8000-000000000003',repeat('c',64),'{}','f6700000-0000-4000-8000-000000000003','object-v3',3);raise exception 'Older unknown branch replaced new capture after lock wait';exception when sqlstate 'PPH01' then null;end;end $$;
SQL
capture_race newer
cat >"$CAPTURE_DIR/replay-first.sql" <<'SQL'
select 1 from public.jobs where id='f6500000-0000-4000-8000-000000000001' for update;
SQL
cat >"$CAPTURE_DIR/replay-second.sql" <<'SQL'
select public.record_job_photo_capture('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000001.jpg','kitchen_1','before','f6600000-0000-4000-8000-000000000001',repeat('a',64),'{}','f6700000-0000-4000-8000-000000000001','object-v1',3);
SQL
capture_race replay
cat >"$CAPTURE_DIR/version-first.sql" <<'SQL'
update storage.objects set version='changed-during-hash' where id='f6700000-0000-4000-8000-000000000001';
SQL
cat >"$CAPTURE_DIR/version-second.sql" <<'SQL'
do $$ begin begin perform public.record_job_photo_capture('f6500000-0000-4000-8000-000000000001','f6400000-0000-4000-8000-000000000001','jobs/f6500000-0000-4000-8000-000000000001/kitchen_1-before/f6600000-0000-4000-8000-000000000001.jpg','kitchen_1','before','f6600000-0000-4000-8000-000000000001',repeat('a',64),'{}','f6700000-0000-4000-8000-000000000001','object-v1',3);raise exception 'Changed object version accepted after lock wait';exception when sqlstate 'PPH01' then null;end;end $$;
SQL
capture_race version
capture_sql <<'SQL'
do $$ begin
 if (select count(*) from spotless_private.photo_capture_receipts where job_id='f6500000-0000-4000-8000-000000000001')<>2 or not exists(select 1 from public.job_photos where job_id='f6500000-0000-4000-8000-000000000001' and capture_revision='f6600000-0000-4000-8000-000000000002') or exists(select 1 from public.invoices where job_id='f6500000-0000-4000-8000-000000000001') then raise exception 'Capture races changed current evidence or billing';end if;
 raise notice 'Capture races passed: older unknown branch refused, accepted older replay preserved current retake, changed object version refused after observed lock waits; no invoice or collection.';
end $$;
SQL
