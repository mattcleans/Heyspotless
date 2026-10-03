#!/usr/bin/env bash
# Disposable database only. Observe each blocking session before the competitor.
set -euo pipefail
QUOTE_DB="${1:?pass disposable database}"
QUOTE_DIR=$(mktemp -d)
trap 'rm -rf "$QUOTE_DIR"' EXIT
quote_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$QUOTE_DB" "$@"; }
quote_barrier() {
 local quote_app="$1" quote_seen
 for _ in $(seq 1 100); do
  quote_seen=$(quote_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$quote_app' and wait_event='PgSleep'")
  if [ "$quote_seen" = 1 ]; then return;fi
  sleep .05
 done
 echo "quote race missed observed barrier: $quote_app" >&2
 return 1
}
python3 - <<'PY' >"$QUOTE_DIR/setup.sql"
from pathlib import Path
s=Path('scripts/verify-client-quotes.sql').read_text().split('create temporary table quote_test_saved')[0]
print(s.replace('begin;', '', 1))
PY
quote_sql -f "$QUOTE_DIR/setup.sql"
# Prepare retries wait on the request key and recover one immutable review.
PGAPPNAME=quote_prepare_first quote_sql >"$QUOTE_DIR/prepare" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select prepare_client_quote('c8400000-0000-0000-0000-000000000001','c8300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',clock_timestamp()+interval '30 days')+interval '15 hours',date_trunc('day',clock_timestamp()+interval '7 days')+interval '15 hours',false,'[]','');
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_prepare_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
select prepare_client_quote('c8400000-0000-0000-0000-000000000001','c8300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',clock_timestamp()+interval '30 days')+interval '15 hours',date_trunc('day',clock_timestamp()+interval '7 days')+interval '15 hours',false,'[]','');
select prepare_client_quote(('c8400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'c8300000-0000-0000-0000-000000000001','standard',case when n=4 then 'weekly'::frequency else 'one_time'::frequency end,date_trunc('day',clock_timestamp()+interval '30 days')+interval '15 hours',date_trunc('day',clock_timestamp()+interval '7 days')+interval '15 hours',n=4,'[]','') from generate_series(2,7)n;
select publish_client_quote(('c8400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid) from generate_series(2,7)n where n<>5;
reset role;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',false);
set role authenticated;
select decide_client_quote(('c8400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,uuid_generate_v4(),1,true) from generate_series(2,7)n where n<>5;
SQL
wait "$QUOTE_PID"
# Client withdrawal wins. The old accepted version cannot be booked.
PGAPPNAME=quote_client_first quote_sql >"$QUOTE_DIR/client" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select decide_client_quote('c8400000-0000-0000-0000-000000000002',uuid_generate_v4(),2,false);
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_client_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
do $$ begin begin perform book_client_quote('c8400000-0000-0000-0000-000000000002',2);raise exception 'Withdrawn acceptance booked';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$QUOTE_PID"
# Booking wins. A later withdrawal must use the visit cancellation policy.
PGAPPNAME=quote_book_first quote_sql >"$QUOTE_DIR/book" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select book_client_quote('c8400000-0000-0000-0000-000000000003',2);
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_book_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',false);
set role authenticated;
do $$ begin begin perform decide_client_quote('c8400000-0000-0000-0000-000000000003',uuid_generate_v4(),2,false);raise exception 'Booked acceptance withdrawn';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$QUOTE_PID"
# Concurrent office retry creates one first visit and one recurring plan.
PGAPPNAME=quote_repeat_first quote_sql >"$QUOTE_DIR/repeat" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select book_client_quote('c8400000-0000-0000-0000-000000000004',2);
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_repeat_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
select book_client_quote('c8400000-0000-0000-0000-000000000004',2);
SQL
wait "$QUOTE_PID"
# Expiry is read after waiting for the real lock, using the actual clock.
PGAPPNAME=quote_expiry_first quote_sql >"$QUOTE_DIR/expiry" <<'SQL' &
begin;
update spotless_private.client_quote_terms set expires_at=clock_timestamp()+interval '1 second' where id='c8400000-0000-0000-0000-000000000005';
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_expiry_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
do $$ begin begin perform publish_client_quote('c8400000-0000-0000-0000-000000000005');raise exception 'Expired quote published after wait';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$QUOTE_PID"
# A home edit wins the property lock; booking must revalidate the saved rooms.
PGAPPNAME=quote_home_first quote_sql >"$QUOTE_DIR/home" <<'SQL' &
begin;
update properties set bedrooms=3 where id='c8300000-0000-0000-0000-000000000001';
select pg_sleep(2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_home_first
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
do $$ begin begin perform book_client_quote('c8400000-0000-0000-0000-000000000006',2);raise exception 'Changed home booked after wait';exception when sqlstate 'PT409' then null;end;end $$;
SQL
wait "$QUOTE_PID"
quote_sql -c "update properties set bedrooms=2 where id='c8300000-0000-0000-0000-000000000001'"
# Real Repeatable Read snapshot failure stays retryable, not a saved receipt.
PGAPPNAME=quote_rr_reader quote_sql >"$QUOTE_DIR/rr" 2>&1 <<'SQL' &
begin isolation level repeatable read;
select count(*) from quotes;
select pg_sleep(2);
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select book_client_quote('c8400000-0000-0000-0000-000000000007',2);
commit;
SQL
QUOTE_PID=$!
quote_barrier quote_rr_reader
quote_sql <<'SQL'
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',false);
set role authenticated;
select book_client_quote('c8400000-0000-0000-0000-000000000007',2);
SQL
if wait "$QUOTE_PID";then echo 'Stale Repeatable Read booking did not abort' >&2;exit 1;fi
if ! rg -q 'could not serialize access due to concurrent update' "$QUOTE_DIR/rr";then cat "$QUOTE_DIR/rr";exit 1;fi
quote_sql <<'SQL'
do $$ begin
 if (select count(*) from quotes where id::text like 'c8400000-%')<>7 or (select count(*) from jobs where quote_id::text like 'c8400000-%')<>3 or (select count(*) from recurring_plans where property_id='c8300000-0000-0000-0000-000000000001')<>1 then raise exception 'Concurrent quote workflow duplicated terms, visit or plan';end if;
 if exists(select 1 from jobs where quote_id in ('c8400000-0000-0000-0000-000000000002','c8400000-0000-0000-0000-000000000006')) then raise exception 'Rejected booking created a visit';end if;
 if (select state from spotless_private.client_quote_terms where id='c8400000-0000-0000-0000-000000000005')<>'review' then raise exception 'Expired review published';end if;
 if exists(select 1 from invoices where customer_id='c8200000-0000-0000-0000-000000000001') then raise exception 'Quote workflow charged client';end if;
 raise notice 'Client quote races passed: prepare retry, withdrawal/booking, booking/withdrawal, recurring retry, actual expiry, home edit and repeatable-read retry';
end $$;
SQL
