#!/usr/bin/env bash
# Disposable database only. Each competitor starts after an observed live lock.
set -euo pipefail
BOOKING_DB="${1:?pass disposable database}"
BOOKING_TMP=$(mktemp -d)
trap 'rm -rf "$BOOKING_TMP"' EXIT
booking_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$BOOKING_DB" "$@"; }
booking_barrier() {
 local booking_app="$1" booking_event="$2" booking_seen
 for _ in $(seq 1 120); do
  booking_seen=$(booking_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$booking_app' and wait_event='$booking_event'")
  if [ "$booking_seen" = 1 ];then return;fi
  sleep .05
 done
 echo "owned booking race missed observed barrier: $booking_app" >&2;return 1
}
python3 - <<'PY' >"$BOOKING_TMP/setup.sql"
from pathlib import Path
s=Path('scripts/verify-owned-client-booking.sql').read_text().split('create temporary table booking_test_saved')[0]
print(s.replace('begin;', '', 1))
PY
booking_sql -f "$BOOKING_TMP/setup.sql"
booking_sql <<'SQL'
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',false);
set role authenticated;
select review_my_booking(('c9400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'c9300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',now()+interval '30 days')+interval '15 hours'+make_interval(days=>case when n<=2 then 0 else 5 end),false,'[]','Synthetic concurrent request') from generate_series(1,4)n;
SQL
PGAPPNAME=owned_booking_first booking_sql >"$BOOKING_TMP/first" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_my_booking('c9400000-0000-0000-0000-000000000001');
select pg_sleep(4);
commit;
SQL
BOOKING_FIRST_PID=$!
booking_barrier owned_booking_first PgSleep
PGAPPNAME=owned_booking_competing booking_sql >"$BOOKING_TMP/competing" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 begin perform confirm_my_booking('c9400000-0000-0000-0000-000000000002');raise exception 'Competing time created a second visit';exception when sqlstate 'PBO01' then null;end;
end $$;
commit;
SQL
BOOKING_OTHER_PID=$!
booking_barrier owned_booking_competing transactionid
# A simultaneous retry of the first identity must recover its single saved job.
booking_sql >"$BOOKING_TMP/retry" <<'SQL'
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',false);
set role authenticated;
select confirm_my_booking('c9400000-0000-0000-0000-000000000001');
SQL
wait "$BOOKING_FIRST_PID";wait "$BOOKING_OTHER_PID"
booking_sql <<'SQL'
do $$ begin
 if (select count(*) from jobs where property_id='c9300000-0000-0000-0000-000000000001')<>1
 or (select count(*) from spotless_private.client_booking_reviews where property_id='c9300000-0000-0000-0000-000000000001' and confirmed_at is not null)<>1 then raise exception 'Concurrent request duplicated saved outcome';end if;
end $$;
SQL
# An older repeatable-read snapshot cannot insert an overlapping second visit.
PGAPPNAME=owned_booking_rr_first booking_sql >"$BOOKING_TMP/rr-first" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_my_booking('c9400000-0000-0000-0000-000000000003');
select pg_sleep(4);
commit;
SQL
BOOKING_FIRST_PID=$!
booking_barrier owned_booking_rr_first PgSleep
booking_sql >"$BOOKING_TMP/rr-other" <<'SQL'
begin isolation level repeatable read;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select read_my_booking_reviews();
do $$ begin
 begin perform confirm_my_booking('c9400000-0000-0000-0000-000000000004');raise exception 'Old snapshot duplicated a visit';exception when serialization_failure then null;end;
end $$;
commit;
SQL
wait "$BOOKING_FIRST_PID"
booking_sql <<'SQL'
do $$ begin
 if (select count(*) from jobs where property_id='c9300000-0000-0000-0000-000000000001')<>2
 or exists(select 1 from spotless_private.client_booking_reviews where id in('c9400000-0000-0000-0000-000000000002','c9400000-0000-0000-0000-000000000004') and confirmed_at is not null) then raise exception 'Competing review incorrectly confirmed';end if;
end $$;
SQL
