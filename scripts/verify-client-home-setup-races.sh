#!/usr/bin/env bash
# Disposable database only; observe the lock before starting a competing save.
set -euo pipefail
HOME_SETUP_DB="${1:?pass disposable database}"
HOME_SETUP_TMP=$(mktemp -d)
trap 'rm -rf "$HOME_SETUP_TMP"' EXIT
home_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$HOME_SETUP_DB" "$@"; }
home_barrier() {
 local home_app="$1" home_event="$2" home_seen
 for _ in $(seq 1 120); do
  home_seen=$(home_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$home_app' and wait_event='$home_event'")
  if [ "$home_seen" = 1 ]; then return; fi
  sleep .05
 done
 echo "Client home race missed observed lock: $home_app" >&2; return 1
}
home_sql <<'SQL'
insert into auth.users(id,email,email_confirmed_at) values('d9500000-0000-4000-8000-000000000001','home-race@example.test',now());
SQL
cat >"$HOME_SETUP_TMP/save.sql" <<'SQL'
select save_my_home('d9600000-0000-4000-8000-000000000001',
 '{"street":"100 Synthetic Concurrent Way","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":2,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":1}',
 '{"firstName":"Concurrent","lastName":"Client","phone":"469-555-0100"}');
SQL
PGAPPNAME=home_setup_first home_sql >"$HOME_SETUP_TMP/first" <<SQL &
begin;
select set_config('request.jwt.claim.sub','d9500000-0000-4000-8000-000000000001',true);
set local role authenticated;
\i $HOME_SETUP_TMP/save.sql
select pg_sleep(4);
commit;
SQL
HOME_SETUP_FIRST_PID=$!
home_barrier home_setup_first PgSleep
PGAPPNAME=home_setup_second home_sql >"$HOME_SETUP_TMP/second" <<SQL &
begin;
select set_config('request.jwt.claim.sub','d9500000-0000-4000-8000-000000000001',true);
set local role authenticated;
\i $HOME_SETUP_TMP/save.sql
commit;
SQL
HOME_SETUP_SECOND_PID=$!
home_barrier home_setup_second transactionid
home_sql >"$HOME_SETUP_TMP/different-request" <<'SQL'
select set_config('request.jwt.claim.sub','d9500000-0000-4000-8000-000000000001',false);
set role authenticated;
select save_my_home('d9600000-0000-4000-8000-000000000002',
 '{"street":"100 Synthetic Concurrent Way","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":2,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":1}',
 '{"firstName":"Concurrent","lastName":"Client","phone":"469-555-0100"}');
SQL
wait "$HOME_SETUP_FIRST_PID"; wait "$HOME_SETUP_SECOND_PID"
home_sql <<'SQL'
do $$ begin
 if (select count(*) from customers where profile_id='d9500000-0000-4000-8000-000000000001')<>1
 or (select count(*) from properties p join customers c on c.id=p.customer_id where c.profile_id='d9500000-0000-4000-8000-000000000001')<>1
 or (select count(*) from spotless_private.client_home_setups where actor='d9500000-0000-4000-8000-000000000001')<>2 then raise exception 'Concurrent save duplicated Client or home'; end if;
 raise notice 'Client home concurrency: same and different request identities saved one Client and home';
end $$;
SQL

# An older snapshot must abort rather than create another address/customer.
PGAPPNAME=home_setup_rr_first home_sql >"$HOME_SETUP_TMP/rr-first" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','d9500000-0000-4000-8000-000000000001',true);
set local role authenticated;
select save_my_home('d9600000-0000-4000-8000-000000000003',
 '{"street":"200 Synthetic Concurrent Way","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":2,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":1}',null);
select pg_sleep(4);
commit;
SQL
HOME_SETUP_FIRST_PID=$!
home_barrier home_setup_rr_first PgSleep
home_sql >"$HOME_SETUP_TMP/rr-second" <<'SQL'
begin isolation level repeatable read;
select set_config('request.jwt.claim.sub','d9500000-0000-4000-8000-000000000001',true);
set local role authenticated;
select count(*) from properties;
do $$ begin
 begin
  perform save_my_home('d9600000-0000-4000-8000-000000000004',
   '{"street":"200 Synthetic Concurrent Way","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":2,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":1}',null);
  raise exception 'Older snapshot saved a duplicate home';
 exception when serialization_failure then null;end;
end $$;
commit;
SQL
wait "$HOME_SETUP_FIRST_PID"
home_sql <<'SQL'
do $$ begin
 if (select count(*) from properties p join customers c on c.id=p.customer_id where c.profile_id='d9500000-0000-4000-8000-000000000001')<>2
 or exists(select 1 from spotless_private.client_home_setups where actor='d9500000-0000-4000-8000-000000000001' and request_id='d9600000-0000-4000-8000-000000000004') then raise exception 'Older snapshot recorded a duplicate outcome';end if;
 raise notice 'Client home concurrency: older repeatable-read snapshot refused';
end $$;
SQL
