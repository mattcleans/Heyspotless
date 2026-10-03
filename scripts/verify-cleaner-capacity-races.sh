#!/usr/bin/env bash
# Only against verify-migrations.sh's disposable database. Distinct sessions.
set -euo pipefail
CAPACITY_DB="${1:?pass disposable database}"
CAPACITY_DIR=$(mktemp -d)
trap 'rm -rf "$CAPACITY_DIR"' EXIT
capacity_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$CAPACITY_DB" "$@"; }
capacity_barrier() {
 local capacity_app="$1" capacity_event="$2" capacity_seen
 for _ in $(seq 1 100); do
  capacity_seen=$(capacity_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$capacity_app' and (wait_event='$capacity_event' or wait_event_type='$capacity_event')")
  if [ "$capacity_seen" = 1 ]; then return; fi
  sleep .05
 done
 echo "cleaner capacity race missed observed barrier: $capacity_app/$capacity_event" >&2
 return 1
}
capacity_sql <<'SQL'
insert into customers(id,first_name,last_name) values('fa200000-0000-0000-0000-000000000001','Capacity Race','Client');
insert into properties(id,customer_id,street,city,zip) values('fa300000-0000-0000-0000-000000000001','fa200000-0000-0000-0000-000000000001','Sample','Dallas','75001');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared)
 select ('fa400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'Capacity Race '||n,'contractor_1099','active',4.5,true from generate_series(1,5)n;
select spotless_private.lock_cleaner_capacity(array_agg(id)) from cleaners where id::text like 'fa400000-%';
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
 select ('fa500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'fa200000-0000-0000-0000-000000000001','fa300000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,90,
 '2028-02-01 09:00Z'::timestamptz+case when n in (3,5) then interval '6 hours' else interval '0 minutes' end from generate_series(1,10)n;
insert into offers(id,job_id,cleaner_id,channel,tier,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at)
 select ('fa600000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,id,('fa400000-0000-0000-0000-'||lpad(((n+1)/2)::text,12,'0'))::uuid,'open_board',1,3200,8000,0.4,90,clock_timestamp()+interval '1 hour'
 from (select *,right(id::text,12)::integer n from jobs where id::text like 'fa500000-%')j where n not in (3,5);
insert into job_assignments(job_id,cleaner_id,payout_cents) values
 ('fa500000-0000-0000-0000-000000000003','fa400000-0000-0000-0000-000000000002',5000),
 ('fa500000-0000-0000-0000-000000000005','fa400000-0000-0000-0000-000000000003',5000);
SQL
# Different job locks, same cleaner: only one overlapping offer can win.
PGAPPNAME=capacity_first capacity_sql >"$CAPACITY_DIR/first" <<'SQL' &
begin;
select respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000001','fa400000-0000-0000-0000-000000000001',true);
select pg_sleep(2);
commit;
SQL
CAPACITY_PID=$!
capacity_barrier capacity_first PgSleep
capacity_sql <<'SQL'
do $$ begin
 if respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000002','fa400000-0000-0000-0000-000000000001',true)<>'conflict' then raise exception 'Concurrent overlapping acceptance won';end if;
 if (select count(*) from job_assignments where cleaner_id='fa400000-0000-0000-0000-000000000001')<>1 then raise exception 'Cleaner double booked';end if;
 if not exists(select 1 from offers where id='fa600000-0000-0000-0000-000000000002' and status='withdrawn' and capacity_conflict_at is not null and decline_reason is null) then raise exception 'Concurrent loser counted as decline';end if;
end $$;
SQL
wait "$CAPACITY_PID"
# A retained assignment's time change wins first; the competing offer waits.
PGAPPNAME=capacity_move_first capacity_sql >"$CAPACITY_DIR/move" <<'SQL' &
begin;
update jobs set scheduled_start='2028-02-01 09:00Z' where id='fa500000-0000-0000-0000-000000000003';
select pg_sleep(2);
commit;
SQL
CAPACITY_PID=$!
capacity_barrier capacity_move_first PgSleep
capacity_sql <<'SQL'
do $$ begin
 if respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000004','fa400000-0000-0000-0000-000000000002',true)<>'conflict' then raise exception 'Acceptance ignored concurrent appointment change';end if;
end $$;
SQL
wait "$CAPACITY_PID"
# Acceptance wins first; a conflicting move must roll back to its old time.
PGAPPNAME=capacity_accept_first capacity_sql >"$CAPACITY_DIR/accept" <<'SQL' &
begin;
select respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000006','fa400000-0000-0000-0000-000000000003',true);
select pg_sleep(2);
commit;
SQL
CAPACITY_PID=$!
capacity_barrier capacity_accept_first PgSleep
capacity_sql <<'SQL'
do $$ begin
 begin update jobs set scheduled_start='2028-02-01 09:00Z' where id='fa500000-0000-0000-0000-000000000005';raise exception 'Move ignored concurrent acceptance';exception when sqlstate 'PCP01' then null;end;
 if (select scheduled_start from jobs where id='fa500000-0000-0000-0000-000000000005')<>'2028-02-01 15:00Z'::timestamptz then raise exception 'Rejected move left writes';end if;
end $$;
SQL
wait "$CAPACITY_PID"
# Repeatable Read sees a pre-commit snapshot, then waits on the changed mutex.
# This must raise the engine's 40001; abort and retry the ENTIRE transaction.
PGAPPNAME=capacity_rr_winner capacity_sql >"$CAPACITY_DIR/rr-winner" <<'SQL' &
begin;
select respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000007','fa400000-0000-0000-0000-000000000004',true);
select pg_sleep(5);
commit;
SQL
CAPACITY_PID=$!
capacity_barrier capacity_rr_winner PgSleep
PGAPPNAME=capacity_rr_loser capacity_sql -v VERBOSITY=verbose >"$CAPACITY_DIR/rr-loser" 2>&1 <<'SQL' &
begin isolation level repeatable read;
select count(*) from job_assignments where cleaner_id='fa400000-0000-0000-0000-000000000004';
select respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000008','fa400000-0000-0000-0000-000000000004',true);
commit;
SQL
CAPACITY_RR_PID=$!
capacity_barrier capacity_rr_loser Lock
wait "$CAPACITY_PID"
if wait "$CAPACITY_RR_PID"; then echo 'Repeatable Read accepted stale capacity' >&2;exit 1;fi
if ! grep -q '40001' "$CAPACITY_DIR/rr-loser"; then cat "$CAPACITY_DIR/rr-loser" >&2;exit 1;fi
capacity_sql <<'SQL'
do $$ begin
 if respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000008','fa400000-0000-0000-0000-000000000004',true)<>'conflict' then raise exception 'Whole-transaction retry did not see committed assignment';end if;
 if (select count(*) from job_assignments where cleaner_id='fa400000-0000-0000-0000-000000000004')<>1 then raise exception 'Repeatable Read double booked';end if;
 raise notice 'Cleaner capacity races: overlapping acceptances, both time-change orders and genuine Repeatable Read retry verified';
end $$;
SQL

# Expiry changes while capacity is locked: re-read after waiting, and use the
# wall clock rather than the request transaction's earlier now().
PGAPPNAME=capacity_expiry_first capacity_sql >"$CAPACITY_DIR/expiry" <<'SQL' &
begin;
select respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000009','fa400000-0000-0000-0000-000000000005',true);
update offers set expires_at=clock_timestamp()+interval '1 second' where id='fa600000-0000-0000-0000-000000000010';
select pg_sleep(2);
commit;
SQL
CAPACITY_PID=$!
capacity_barrier capacity_expiry_first PgSleep
capacity_sql <<'SQL'
do $$ begin
 if respond_to_offer_with_capacity('fa600000-0000-0000-0000-000000000010','fa400000-0000-0000-0000-000000000005',true)<>'expired' then raise exception 'Expired offer accepted or mislabeled after capacity wait';end if;
 if exists(select 1 from job_assignments where job_id='fa500000-0000-0000-0000-000000000010') then raise exception 'Expired offer assigned';end if;
 if not exists(select 1 from offers where id='fa600000-0000-0000-0000-000000000010' and status='expired' and capacity_conflict_at is null) then raise exception 'Expiry became a capacity decline';end if;
 raise notice 'Cleaner capacity expiry: locked wait re-read and wall-clock deadline verified';
end $$;
SQL
wait "$CAPACITY_PID"
