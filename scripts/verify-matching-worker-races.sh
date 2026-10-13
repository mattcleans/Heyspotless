#!/usr/bin/env bash
set -euo pipefail
WORKER_DB="${1:?pass disposable database}"
WORKER_TMP=$(mktemp -d)
trap 'rm -rf "$WORKER_TMP"' EXIT
worker_sql(){ psql -X -v ON_ERROR_STOP=1 -q -d "$WORKER_DB" "$@"; }
worker_barrier(){
 local worker_name="$1" worker_event="$2" worker_seen
 for _ in $(seq 1 120);do
  worker_seen=$(worker_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$worker_name' and wait_event='$worker_event'")
  if [ "$worker_seen" = 1 ];then return;fi
  sleep .05
 done
 echo "Matching worker missed observed concurrency barrier" >&2;return 1
}
PGAPPNAME=matching_worker_first worker_sql >"$WORKER_TMP/first" <<'SQL' &
begin;
set local role service_role;
do $$ begin
 if not claim_matching_worker('f1200000-0000-4000-8000-000000000001',180) then raise exception 'First worker not claimed';end if;
end $$;
select pg_sleep(4);
commit;
SQL
WORKER_FIRST_PID=$!
worker_barrier matching_worker_first PgSleep
PGAPPNAME=matching_worker_second worker_sql >"$WORKER_TMP/second" <<'SQL' &
begin;
set local role service_role;
do $$ begin
 if claim_matching_worker('f1200000-0000-4000-8000-000000000002',180) then raise exception 'Concurrent worker also claimed';end if;
end $$;
commit;
SQL
WORKER_SECOND_PID=$!
worker_barrier matching_worker_second transactionid
wait "$WORKER_FIRST_PID";wait "$WORKER_SECOND_PID"
worker_sql <<'SQL'
set role service_role;
do $$ begin
 if finish_matching_worker('f1200000-0000-4000-8000-000000000002','success','{}') then raise exception 'Unowned worker finished lease';end if;
 if not finish_matching_worker('f1200000-0000-4000-8000-000000000001','success','{"jobs":0}') then raise exception 'Owned worker could not finish';end if;
 raise notice 'Matching worker concurrency: one lease acquired and current owner finished';
end $$;
SQL
