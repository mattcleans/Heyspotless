#!/usr/bin/env bash
# Distinct connections against the verifier's disposable PostgreSQL database.
set -euo pipefail
SERIES_DB="${1:?pass disposable database}"
SERIES_DIR=$(mktemp -d)
trap 'rm -rf "$SERIES_DIR"' EXIT
series_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$SERIES_DB" "$@"; }
series_barrier() {
 local series_app="$1" series_seen
 for _ in $(seq 1 100); do
  series_seen=$(series_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$series_app' and wait_event='PgSleep'")
  if [ "$series_seen" = 1 ]; then return; fi
  sleep .05
 done
 echo "recurring race did not reach lock barrier: $series_app" >&2
 return 1
}
series_sql <<'SQL'
insert into auth.users(id,email) values('e1000000-0000-0000-0000-000000000001','series-race@example.test');
insert into customers(id,profile_id,first_name,last_name) values('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','Series Race','Client');
insert into properties(id,customer_id,street,city,zip) values('e3000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','Sample','Dallas','75001');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared) values('e4000000-0000-0000-0000-000000000001','Series Race Cleaner','contractor_1099','active',4.5,true);
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date,start_time,horizon_days)
 select ('e9000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001','standard','weekly',20000,90,(clock_timestamp() at time zone 'America/Chicago')::date+1,'09:30',7 from generate_series(1,4)n;
select materialise_recurring_job(id,anchor_date,recurring_start_at(anchor_date,start_time)) from recurring_plans where id::text like 'e9000000-%';
update jobs set status='assigned' where recurring_plan_id::text like 'e9000000-%';
insert into job_assignments(job_id,cleaner_id,payout_cents) select id,'e4000000-0000-0000-0000-000000000001',5000 from jobs where recurring_plan_id::text like 'e9000000-%';
set request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
select quote_my_recurring_schedule(id,anchor_date,'weekly','10:30',null,null) from recurring_plans where id::text like 'e9000000-%';
SQL
PGAPPNAME=series_start_first series_sql >"$SERIES_DIR/start" <<'SQL' &
begin;
select start_job((select id from jobs where recurring_plan_id='e9000000-0000-0000-0000-000000000001'),'e4000000-0000-0000-0000-000000000001');
select pg_sleep(2);
commit;
SQL
SERIES_PID=$!
series_barrier series_start_first
series_sql <<'SQL'
set request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
do $$ begin
 begin perform confirm_my_recurring_schedule('e9000000-0000-0000-0000-000000000001',(select id from recurring_schedule_quotes where plan_id='e9000000-0000-0000-0000-000000000001'));raise exception 'edit followed started work';exception when serialization_failure then null;end;
 if (select generation_epoch from recurring_plans where id='e9000000-0000-0000-0000-000000000001')<>1 or exists(select 1 from recurring_schedule_changes where plan_id='e9000000-0000-0000-0000-000000000001') then raise exception 'rejected start-first edit left writes';end if;
end $$;
SQL
wait "$SERIES_PID"
PGAPPNAME=series_edit_first series_sql >"$SERIES_DIR/edit" <<'SQL' &
begin;
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
select confirm_my_recurring_schedule('e9000000-0000-0000-0000-000000000002',(select id from recurring_schedule_quotes where plan_id='e9000000-0000-0000-0000-000000000002'));
select pg_sleep(2);
commit;
SQL
SERIES_PID=$!
series_barrier series_edit_first
series_sql <<'SQL'
do $$ declare p uuid:='e9000000-0000-0000-0000-000000000002';j uuid;begin
 select id into j from jobs where recurring_plan_id=p order by scheduled_start limit 1;
 if start_job(j,'e4000000-0000-0000-0000-000000000001') then raise exception 'old cleaner started after recurring edit';end if;
 if assign_job_for_schedule(j,'e4000000-0000-0000-0000-000000000001',5000,1) then raise exception 'stale dispatch filled moved recurring visit';end if;
 begin perform materialise_recurring_job_for_revision(p,(select anchor_date+7 from recurring_plans where id=p),recurring_start_at((select anchor_date+7 from recurring_plans where id=p),'09:30'),1);raise exception 'stale generator followed recurring edit';exception when serialization_failure then null;end;
 if (select count(*) from recurring_schedule_releases where job_id=j)<>1 or exists(select 1 from time_entries where job_id=j) then raise exception 'release/start race broken';end if;
end $$;
SQL
wait "$SERIES_PID"
PGAPPNAME=series_retry_first series_sql >"$SERIES_DIR/retry" <<'SQL' &
begin;
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
select confirm_my_recurring_schedule('e9000000-0000-0000-0000-000000000003',(select id from recurring_schedule_quotes where plan_id='e9000000-0000-0000-0000-000000000003'));
select pg_sleep(2);
commit;
SQL
SERIES_PID=$!
series_barrier series_retry_first
series_sql <<'SQL'
set request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
do $$ declare p uuid:='e9000000-0000-0000-0000-000000000003';r jsonb;begin
 r:=confirm_my_recurring_schedule(p,(select id from recurring_schedule_quotes where plan_id=p));
 if (select count(*) from recurring_schedule_changes where plan_id=p)<>1 or (select generation_epoch from recurring_plans where id=p)<>2 or (select count(*) from jobs where recurring_plan_id=p and generation_epoch=2)<>2 or (select count(*) from recurring_schedule_releases x join jobs j on j.id=x.job_id where j.recurring_plan_id=p)<>1 then raise exception 'concurrent confirmation duplicated changes';end if;
end $$;
SQL
wait "$SERIES_PID"
PGAPPNAME=series_generation_first series_sql >"$SERIES_DIR/generation" <<'SQL' &
begin;
select materialise_recurring_job_for_revision(id,anchor_date+7,recurring_start_at(anchor_date+7,'09:30'),1) from recurring_plans where id='e9000000-0000-0000-0000-000000000004';
select pg_sleep(2);
commit;
SQL
SERIES_PID=$!
series_barrier series_generation_first
series_sql <<'SQL'
set request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
do $$ declare p uuid:='e9000000-0000-0000-0000-000000000004';begin
 begin perform confirm_my_recurring_schedule(p,(select id from recurring_schedule_quotes where plan_id=p));raise exception 'new generated visit absent from accepted review';exception when serialization_failure then null;end;
 if (select generation_epoch from recurring_plans where id=p)<>1 or exists(select 1 from recurring_schedule_changes where plan_id=p) then raise exception 'rejected generation-first edit left changes';end if;
end $$;
SQL
wait "$SERIES_PID"
echo "  concurrent recurring edit/start/dispatch/generation/retry verified"
