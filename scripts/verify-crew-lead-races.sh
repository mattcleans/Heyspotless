#!/usr/bin/env bash
# Distinct PostgreSQL sessions; only the disposable verification database.
set -euo pipefail
CREW_DB="${1:?pass disposable database}"
CREW_DIR=$(mktemp -d)
trap 'rm -rf "$CREW_DIR"' EXIT
crew_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$CREW_DB" "$@"; }
crew_barrier() {
 local crew_app="$1" crew_event="$2" crew_seen
 for _ in $(seq 1 100); do
  crew_seen=$(crew_sql -tAc "select count(*) from pg_stat_activity where datname=current_database() and application_name='$crew_app' and (wait_event='$crew_event' or wait_event_type='$crew_event')")
  if [ "$crew_seen" = 1 ]; then return; fi
  sleep .05
 done
 echo "crew race missed observed barrier: $crew_app/$crew_event" >&2
 return 1
}
# The rollback test completed earlier, so these fixture IDs are fresh. Extract
# only setup before its temporary receipts and role-driven workflow tests.
python3 - <<'PY' >"$CREW_DIR/setup.sql"
from pathlib import Path
s=Path('scripts/verify-crew-lead-replacement.sql').read_text()
s=s[:s.index('create temporary table crew_test_saved')]
print(s.replace('begin;', '', 1))
PY
crew_sql -f "$CREW_DIR/setup.sql"
crew_sql -c "grant select,insert,update,delete on cleaner_availability to authenticated"
crew_sql <<'SQL'
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',false);
set role authenticated;
select confirm_crew_lead_replacement((quote_crew_lead_replacement(('c7500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'c7400000-0000-0000-0000-000000000004')->>'id')::uuid) from generate_series(1,6)n;
SQL
# Client re-approves the old lead first. A competing replacement cannot undo it.
PGAPPNAME=crew_client_first crew_sql >"$CREW_DIR/client" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select respond_my_visit_backup('c7500000-0000-0000-0000-000000000001',(select id from client_visit_assignments where job_id='c7500000-0000-0000-0000-000000000001' and is_lead),'c7400000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000002',public.uuid_generate_v4(),true,'','c7800000-0000-0000-0000-000000000001');
select pg_sleep(2);
commit;
SQL
CREW_PID=$!
crew_barrier crew_client_first PgSleep
crew_sql <<'SQL'
do $$ declare q uuid;r jsonb;begin
 select id into q from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000001';
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 r:=respond_my_crew_lead_offer(q,true);
 if r->>'state'<>'withdrawn' or not exists(select 1 from job_assignments where job_id='c7500000-0000-0000-0000-000000000001' and is_lead and cleaner_id='c7400000-0000-0000-0000-000000000002') then raise exception 'Replacement overrode concurrent client approval';end if;
end $$;
SQL
wait "$CREW_PID"
# Replacement acceptance first. A cancellation/retry of the sent offer cannot
# delete the winner or duplicate the removed lead's notice.
PGAPPNAME=crew_accept_first crew_sql >"$CREW_DIR/accept" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
select respond_my_crew_lead_offer((select id from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000002'),true);
select pg_sleep(2);
commit;
SQL
CREW_PID=$!
crew_barrier crew_accept_first PgSleep
crew_sql <<'SQL'
do $$ declare q uuid;begin
 select id into q from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000002';
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',true);
 if withdraw_crew_lead_offer(q)->>'state'<>'accepted' then raise exception 'Withdrawal undid accepted replacement';end if;
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 if respond_my_crew_lead_offer(q,true)->>'state'<>'accepted' or (select count(*) from crew_lead_releases where id=q)<>1 then raise exception 'Competing retry duplicated replacement';end if;
 begin perform start_job('c7500000-0000-0000-0000-000000000002','c7400000-0000-0000-0000-000000000004');raise exception 'Concurrent replacement became pre-approved';exception when sqlstate 'PBC01' then null;end;
end $$;
SQL
wait "$CREW_PID"
# A different job reserves this candidate's capacity before acceptance.
PGAPPNAME=crew_capacity_first crew_sql >"$CREW_DIR/capacity" <<'SQL' &
begin;
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
 values('c7500000-0000-0000-0000-000000000099','c7200000-0000-0000-0000-000000000001','c7300000-0000-0000-0000-000000000001','assigned','standard','one_time',24000,90,'2028-01-06 15:00Z');
insert into job_assignments(job_id,cleaner_id,payout_cents) values('c7500000-0000-0000-0000-000000000099','c7400000-0000-0000-0000-000000000004',8000);
select pg_sleep(2);
commit;
SQL
CREW_PID=$!
crew_barrier crew_capacity_first PgSleep
crew_sql <<'SQL'
do $$ declare q uuid;begin
 select id into q from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000003';
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 if respond_my_crew_lead_offer(q,true)->>'state'<>'conflict' then raise exception 'Replacement ignored concurrent capacity reservation';end if;
 if (select count(*) from job_assignments where job_id='c7500000-0000-0000-0000-000000000003')<>2 or not exists(select 1 from job_assignments where job_id='c7500000-0000-0000-0000-000000000003' and is_lead and cleaner_id='c7400000-0000-0000-0000-000000000002') then raise exception 'Capacity loser damaged original crew';end if;
end $$;
SQL
wait "$CREW_PID"
# Declared working hours change first. The proposal must wait on the editor's
# lock and then honor the committed declaration, including an empty visit day.
PGAPPNAME=crew_hours_first crew_sql >"$CREW_DIR/hours" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
set local role authenticated;
select set_my_availability('[{"day":0,"startsAt":"08:00","endsAt":"09:00"}]');
select pg_sleep(2);
commit;
SQL
CREW_PID=$!
crew_barrier crew_hours_first PgSleep
crew_sql <<'SQL'
do $$ begin
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 if respond_my_crew_lead_offer((select id from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000004'),true)->>'state'<>'conflict' then raise exception 'Replacement ignored concurrent working hours';end if;
end $$;
delete from cleaner_availability where cleaner_id='c7400000-0000-0000-0000-000000000004';
SQL
wait "$CREW_PID"
# Wall-clock expiry while waiting for capacity (not a declaration of failure
# due to a capacity conflict). The save must remain atomic after the wait.
PGAPPNAME=crew_expiry_wait crew_sql >"$CREW_DIR/expiry" <<'SQL' &
begin;
select spotless_private.lock_cleaner_capacity(array['c7400000-0000-0000-0000-000000000004'::uuid]);
select pg_sleep(5);
commit;
SQL
CREW_PID=$!
crew_barrier crew_expiry_wait PgSleep
crew_sql -c "update spotless_private.crew_lead_proposals set expires_at=clock_timestamp()+interval '3 seconds' where job_id='c7500000-0000-0000-0000-000000000005'"
PGAPPNAME=crew_expiry_loser crew_sql >"$CREW_DIR/expiry-loser" <<'SQL' &
do $$ begin
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 if respond_my_crew_lead_offer((select id from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000005'),true)->>'state'<>'expired' then raise exception 'Replacement accepted after expiry wait';end if;
end $$;
SQL
CREW_EXPIRY_PID=$!
crew_barrier crew_expiry_loser Lock
wait "$CREW_PID"
wait "$CREW_EXPIRY_PID"
# The normal client reschedule wins the job lock before replacement acceptance.
PGAPPNAME=crew_reschedule_first crew_sql >"$CREW_DIR/reschedule" <<'SQL' &
begin;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select confirm_my_visit_reschedule('c7500000-0000-0000-0000-000000000006',(quote_my_visit_reschedule_with_fee('c7500000-0000-0000-0000-000000000006',(((clock_timestamp() at time zone 'America/Chicago')::date+30+time '12:00') at time zone 'America/Chicago'))->>'id')::uuid);
select pg_sleep(2);
commit;
SQL
CREW_PID=$!
crew_barrier crew_reschedule_first PgSleep
crew_sql <<'SQL'
do $$ begin
 perform set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
 if respond_my_crew_lead_offer((select id from spotless_private.crew_lead_proposals where job_id='c7500000-0000-0000-0000-000000000006'),true)->>'state'<>'withdrawn' then raise exception 'Replacement accepted across reschedule';end if;
 if exists(select 1 from job_assignments where job_id='c7500000-0000-0000-0000-000000000006') then raise exception 'Reschedule/replacement left old crew';end if;
 if (select count(*) from crew_lead_releases)<>1 then raise exception 'A failed replacement left a release';end if;
 raise notice 'Crew races: client decision, acceptance/withdrawal/retry, capacity, declared hours, wall-clock expiry and client reschedule verified';
end $$;
SQL
wait "$CREW_PID"
