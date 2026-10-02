#!/usr/bin/env bash
# Only invoked against the disposable database made by verify-migrations.sh.
set -euo pipefail
MOVE_DB="${1:?pass the disposable verification database}"
MOVE_DIR=$(mktemp -d)
trap 'rm -rf "$MOVE_DIR"' EXIT
move_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$MOVE_DB" "$@"; }
move_sql <<'SQL'
insert into auth.users(id,email) values('a1000000-0000-0000-0000-000000000001','move-race@example.test');
insert into customers(id,profile_id,first_name,last_name) values('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Race','Client');
insert into properties(id,customer_id,street,city,zip) values('a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','Race fixture','Dallas','75001');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared) values('a4000000-0000-0000-0000-000000000001','Race Cleaner','contractor_1099','active',4.5,true);
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start) select
 ('a5000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'a2000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','assigned','standard','one_time',20000,90,date_trunc('minute',now())+n*interval '14 days' from generate_series(1,3)n;
insert into job_assignments(job_id,cleaner_id,payout_cents) select id,'a4000000-0000-0000-0000-000000000001',5000 from jobs where id::text like 'a5000000-%';
set request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select quote_my_visit_reschedule(id,scheduled_start+interval '1 day') from jobs where id::text like 'a5000000-%';
SQL
# Wait for the first transaction to reach its deliberate pause AFTER taking
# the job lock. Observing pg_stat_activity avoids timing-dependent race tests.
move_barrier() {
 local move_app="$1" move_seen
 for _ in $(seq 1 100); do
  move_seen=$(move_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$move_app' and wait_event='PgSleep'")
  if [ "$move_seen" = 1 ]; then return; fi
  sleep .05
 done
 echo "reschedule race did not reach lock barrier: $move_app" >&2
 return 1
}
PGAPPNAME=reschedule_race_start move_sql >"$MOVE_DIR/start-first" <<'SQL' &
begin;
select start_job('a5000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000001');
select pg_sleep(2);
commit;
SQL
MOVE_PID=$!
move_barrier reschedule_race_start
move_sql <<'SQL'
set request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
do $$ begin
 begin
  perform confirm_my_visit_reschedule('a5000000-0000-0000-0000-000000000001',(select id from visit_reschedule_quotes where job_id='a5000000-0000-0000-0000-000000000001'));
  raise exception 'reschedule won after start held lock';
 exception when sqlstate 'PT409' then null; end;
 if (select status from jobs where id='a5000000-0000-0000-0000-000000000001')<>'in_progress' then raise exception 'started visit moved';end if;
 if exists(select 1 from visit_reschedules where job_id='a5000000-0000-0000-0000-000000000001') then raise exception 'rejected reschedule wrote history';end if;
end $$;
SQL
wait "$MOVE_PID"
PGAPPNAME=reschedule_race_move move_sql >"$MOVE_DIR/move-first" <<'SQL' &
begin;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select confirm_my_visit_reschedule('a5000000-0000-0000-0000-000000000002',(select id from visit_reschedule_quotes where job_id='a5000000-0000-0000-0000-000000000002'));
select pg_sleep(2);
commit;
SQL
MOVE_PID=$!
move_barrier reschedule_race_move
move_sql <<'SQL'
do $$ begin
 if start_job('a5000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000001') then raise exception 'old cleaner started after move held lock';end if;
 if (select count(*) from visit_reschedule_releases where job_id='a5000000-0000-0000-0000-000000000002')<>1 then raise exception 'release missing or duplicated';end if;
 if exists(select 1 from time_entries where job_id='a5000000-0000-0000-0000-000000000002') then raise exception 'old start recorded time';end if;
end $$;
SQL
wait "$MOVE_PID"
PGAPPNAME=reschedule_race_dispatch move_sql >"$MOVE_DIR/dispatch-wait" <<'SQL' &
begin;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select confirm_my_visit_reschedule('a5000000-0000-0000-0000-000000000003',(select id from visit_reschedule_quotes where job_id='a5000000-0000-0000-0000-000000000003'));
select pg_sleep(2);
commit;
SQL
MOVE_PID=$!
move_barrier reschedule_race_dispatch
move_sql <<'SQL'
do $$ begin
 if record_offer_for_schedule('a5000000-0000-0000-0000-000000000003','a4000000-0000-0000-0000-000000000001',null,'open_board',1,.25,5000,90,now()+interval '1 day',false,1) is not null then raise exception 'stale waiting sweep offered';end if;
 if assign_job_for_schedule('a5000000-0000-0000-0000-000000000003','a4000000-0000-0000-0000-000000000001',5000,1) then raise exception 'stale waiting sweep assigned';end if;
 if exists(select 1 from job_assignments where job_id='a5000000-0000-0000-0000-000000000003') then raise exception 'moved visit reassigned from stale snapshot';end if;
end $$;
SQL
wait "$MOVE_PID"
echo "  concurrent rescheduling/start/dispatch verified"

# Two confirmations of a paid change must return one receipt and fee invoice.
move_sql <<'SQL'
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start) values
 ('a5000000-0000-0000-0000-000000000004','a2000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,90,
 ((clock_timestamp() at time zone 'America/Chicago')::date+time '12:00') at time zone 'America/Chicago');
set request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select quote_my_visit_reschedule('a5000000-0000-0000-0000-000000000004',
 ((clock_timestamp() at time zone 'America/Chicago')::date+1+time '12:00') at time zone 'America/Chicago');
SQL
PGAPPNAME=reschedule_race_fee move_sql >"$MOVE_DIR/fee-first" <<'SQL' &
begin;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select confirm_my_visit_reschedule('a5000000-0000-0000-0000-000000000004',(select id from visit_reschedule_quotes where job_id='a5000000-0000-0000-0000-000000000004'));
select pg_sleep(2);
commit;
SQL
MOVE_PID=$!
move_barrier reschedule_race_fee
move_sql <<'SQL'
set request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
do $$ declare r jsonb;begin
 r:=confirm_my_visit_reschedule('a5000000-0000-0000-0000-000000000004',(select id from visit_reschedule_quotes where job_id='a5000000-0000-0000-0000-000000000004'));
 if r->>'fee_cents'<>'6000' or (select count(*) from invoices where id=(r->>'invoice_id')::uuid and total_cents=6000)<>1 or
  (select count(*) from visit_reschedules where job_id='a5000000-0000-0000-0000-000000000004')<>1 or
  (select count(*) from invoices where customer_id='a2000000-0000-0000-0000-000000000001' and kind='reschedule_fee')<>1 then raise exception 'concurrent fee retry duplicated/lost receipt';end if;
end $$;
SQL
wait "$MOVE_PID"
echo "  concurrent paid reschedule retry verified"

# A stale generation request waiting behind a plan edit cannot create a visit.
move_sql <<'SQL'
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date,start_time) values
 ('a9000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','standard','weekly',20000,90,'2026-10-03','09:30');
SQL
PGAPPNAME=recurring_race_edit move_sql >"$MOVE_DIR/plan-edit" <<'SQL' &
begin;
update recurring_plans set start_time='10:30' where id='a9000000-0000-0000-0000-000000000001';
select pg_sleep(2);
commit;
SQL
MOVE_PID=$!
move_barrier recurring_race_edit
move_sql <<'SQL'
do $$ declare r record;begin
 begin perform materialise_recurring_job_for_revision('a9000000-0000-0000-0000-000000000001','2026-10-03','2026-10-03T14:30Z',1);
  raise exception 'waiting stale generation created visit';exception when sqlstate 'PT409' then null;end;
 if exists(select 1 from jobs where recurring_plan_id='a9000000-0000-0000-0000-000000000001') then raise exception 'stale generation wrote a visit';end if;
 select * into r from materialise_recurring_job_for_revision('a9000000-0000-0000-0000-000000000001','2026-10-03','2026-10-03T15:30Z',2);
 if not r.created or (select scheduled_start from jobs where id=r.job_id)<>'2026-10-03T15:30Z'::timestamptz then raise exception 'new plan did not generate';end if;
end $$;
SQL
wait "$MOVE_PID"
echo "  concurrent recurring edit/generation verified"
