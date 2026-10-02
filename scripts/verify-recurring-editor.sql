begin;
insert into auth.users(id,email) values
 ('d1000000-0000-0000-0000-000000000001','series-client@example.test'),
 ('d1000000-0000-0000-0000-000000000002','series-other@example.test'),
 ('d1000000-0000-0000-0000-000000000003','series-cleaner@example.test');
update profiles set role='cleaner' where id='d1000000-0000-0000-0000-000000000003';
insert into customers(id,profile_id,first_name,last_name) values
 ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','Series','Client'),
 ('d2000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000002','Other','Client');
insert into properties(id,customer_id,street,city,zip,bedrooms,bathrooms) values
 ('d3000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001','Sample','Dallas','75001',2,2);
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date,start_time,horizon_days) values
 ('d9000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000001','standard','weekly',20000,90,(clock_timestamp() at time zone 'America/Chicago')::date+1,'09:30',21);
insert into cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared) values
 ('d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000003','Series Cleaner','contractor_1099','active',4.5,true);
create temp table series_test_state(k text primary key,v jsonb);
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000001';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;r record;i integer;begin
 for i in 0..3 loop
  select * into r from materialise_recurring_job(p,d+i*7,recurring_start_at(d+i*7,'09:30'));
  insert into series_test_state values('job'||i,to_jsonb(r.job_id));
 end loop;
 -- Two exceptions: one individual move, one bill. An old canceled identity
 -- stays in history, but the new generation may have an appointment that day.
 update jobs set scheduled_start=scheduled_start+interval '1 day',scheduled_end=scheduled_end+interval '1 day' where id=(select v#>>'{}' from series_test_state where k='job1')::uuid;
 insert into invoices(job_id,customer_id,status,subtotal_cents,total_cents) values
 ((select v#>>'{}' from series_test_state where k='job2')::uuid,'d2000000-0000-0000-0000-000000000001','sent',20000,20000);
 update jobs set status='canceled' where id=(select v#>>'{}' from series_test_state where k='job3')::uuid;
 
end $$;
insert into offers(id,job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at)
 values('d6000000-0000-0000-0000-000000000001',(select v#>>'{}' from series_test_state where k='job0')::uuid,
 'd4000000-0000-0000-0000-000000000001','open_board',2000,5000,.25,90,clock_timestamp()+interval '1 day');
select respond_to_offer('d6000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000001',true,null);
update cleaners set status='paused' where id='d4000000-0000-0000-0000-000000000001';

grant select,insert,update on series_test_state to authenticated;
insert into series_test_state values('original',recurring_edit_snapshot('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1));

set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000001';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;q jsonb;begin
 q:=quote_my_recurring_schedule(p,d,'weekly','10:30',null,null);
 if q->'review'->>'price_cents'<>'20000' or q->'review'->>'fee_cents'<>'0' then raise exception 'time-only edit changed price or fee';end if;
 if (select count(*) from jsonb_array_elements(q->'review'->'visits') a where a->>'action'='moved')<>1
  or (select count(*) from jsonb_array_elements(q->'review'->'visits') a where a->>'action'='kept')<>2
  or (select count(*) from jsonb_array_elements(q->'review'->'visits') a where a->>'action'='added')<>1 then raise exception 'review did not preserve exceptions';end if;
 if q ? 'snapshot' or q::text like '%payout_cents%' or q::text like '%assignment_snapshot%' then raise exception 'private review exposed';end if;
 insert into series_test_state values('quote',q);
 -- Review a retained visit before its occurrence key changes.
 insert into series_test_state values('individual',quote_my_visit_reschedule_with_fee((select v#>>'{}' from series_test_state where k='job1')::uuid,((d+9)::text||' 09:30')::timestamp at time zone 'America/Chicago'));
 insert into series_test_state values('cancel',quote_my_visit_cancellation((select v#>>'{}' from series_test_state where k='job1')::uuid,'cancel'));
end $$;
reset role;
do $$ begin
 if (select v from series_test_state where k='original') is distinct from recurring_edit_snapshot('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1) then raise exception 'review changed schedule';end if;
end $$;
set local role authenticated;
do $$ declare rows jsonb;begin
 rows:=read_my_recurring_schedules(null,'d2000000-0000-0000-0000-000000000001');
 if jsonb_array_length(rows)<>1 or rows::text like '%payout%' or rows::text like '%access_notes%' or rows::text like '%gate_code%' then raise exception 'safe plan read exposed private terms';end if;
end $$;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000002',true);
do $$ begin
 begin perform confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(select (v->>'id')::uuid from series_test_state where k='quote'));raise exception 'other client confirmed';exception when insufficient_privilege then null;end;
 if jsonb_array_length(read_my_recurring_schedules('d9000000-0000-0000-0000-000000000001',null))<>0 then raise exception 'other client read plan';end if;
 if exists(select 1 from recurring_schedule_changes where plan_id='d9000000-0000-0000-0000-000000000001') then raise exception 'other client read receipt';end if;
 begin perform 1 from recurring_schedule_quotes;raise exception 'private quotes readable';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare q jsonb;r jsonb;r2 jsonb;begin
 select v into q from series_test_state where k='quote';
 r:=confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(q->>'id')::uuid);
 r2:=confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(q->>'id')::uuid);
 if r is distinct from r2 then raise exception 'retry changed receipt';end if;
 insert into series_test_state values('receipt',r);
 begin perform confirm_my_visit_reschedule((select v#>>'{}' from series_test_state where k='job1')::uuid,(select (v->>'id')::uuid from series_test_state where k='individual'));
  raise exception 'stale individual epoch accepted';exception when serialization_failure then null;end;
 begin perform confirm_my_visit_cancellation((select v#>>'{}' from series_test_state where k='job1')::uuid,(select (v->>'id')::uuid from series_test_state where k='cancel'));
  raise exception 'stale cancellation epoch accepted';exception when serialization_failure then null;end;
end $$;
reset role;
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000001';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;r record;begin
 if (select generation_epoch from recurring_plans where id=p)<>2 or (select schedule_revision from recurring_plans where id=p)<>2 then raise exception 'epoch/revision not advanced exactly once';end if;
 if (select count(*) from jobs where recurring_plan_id=p and generation_epoch=2)<>4 then raise exception 'new generation slots incorrect';end if;
 if not exists(select 1 from jobs where id=(select v#>>'{}' from series_test_state where k='job3')::uuid and status='canceled' and generation_epoch=1) then raise exception 'canceled history rewritten';end if;
 if not exists(select 1 from jobs where id=(select v#>>'{}' from series_test_state where k='job1')::uuid and scheduled_start=recurring_start_at(d+8,'09:30') and occurrence_date=d+7 and price_cents=20000) then raise exception 'individual exception changed';end if;
 if not exists(select 1 from jobs where id=(select v#>>'{}' from series_test_state where k='job2')::uuid and scheduled_start=recurring_start_at(d+14,'09:30') and price_cents=20000) then raise exception 'billed visit changed';end if;
 select * into r from materialise_recurring_job_for_revision(p,d+7,recurring_start_at(d+7,'10:30'),2);
 if r.created or r.job_id<>(select v#>>'{}' from series_test_state where k='job1')::uuid then raise exception 'exception duplicated by sweep';end if;
 if exists(select 1 from visit_cancellations where job_id=(select v#>>'{}' from series_test_state where k='job1')::uuid) or exists(select 1 from recurring_plan_skips where plan_id=p) then raise exception 'stale cancellation left writes';end if;
 if (select count(*) from invoices where customer_id='d2000000-0000-0000-0000-000000000001')<>1 then raise exception 'series edit billed fee';end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000003',true);
do $$ begin
 if (select count(*) from recurring_schedule_releases where cleaner_id='d4000000-0000-0000-0000-000000000001' and payout_cents=5000)<>1 then raise exception 'former agreed pay/release unavailable to cleaner';end if;
 begin perform quote_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1,'weekly','12:00',null,null);raise exception 'cleaner changed client plan';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin
 if exists(select 1 from job_assignments where job_id=(select v#>>'{}' from series_test_state where k='job0')::uuid) or
 (select status from offers where id='d6000000-0000-0000-0000-000000000001')<>'withdrawn' then raise exception 'old cleaner acceptance kept on moved visit';end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare rows jsonb;begin
 rows:=read_my_recurring_visit_changes((select v#>>'{}' from series_test_state where k='job0')::uuid);
 if jsonb_array_length(rows)<>1 or rows::text like '%payout%' then raise exception 'visit history missing or private';end if;
end $$;
reset role;
-- New price from the price book is reviewed. Billed and individually changed
-- visits keep their terms; excess ordinary appointments are removed for free.
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000001';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;q jsonb;r jsonb;begin
 q:=quote_my_recurring_schedule(p,d,'biweekly','11:00',null,null);
 if q->'review'->>'price_cents'=(q->'review'->>'previous_price_cents') then raise exception 'frequency price not requoted';end if;
 insert into series_test_state values('second',q);
 r:=confirm_my_recurring_schedule(p,(q->>'id')::uuid);
 if not exists(select 1 from jsonb_array_elements(r->'review'->'visits') a where a->>'action'='removed') then raise exception 'excess appointments not removed';end if;
end $$;
reset role;
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000001';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;v_job uuid;begin
 if (select generation_epoch from recurring_plans where id=p)<>3 then raise exception 'repeat epoch not advanced';end if;
 select job_id into v_job from recurring_schedule_job_changes where change_id=(select (v->>'id')::uuid from series_test_state where k='second') and action='removed' limit 1;
 begin update jobs set status='scheduled' where id=v_job;raise exception 'removed visit reopened';exception when check_violation then null;end;
 begin insert into invoices(job_id,customer_id,status,subtotal_cents,total_cents) values(v_job,'d2000000-0000-0000-0000-000000000001','sent',20000,20000);raise exception 'removed visit invoiced';exception when check_violation then null;end;
 begin perform materialise_recurring_job_for_revision(p,d,recurring_start_at(d,'10:30'),2);raise exception 'stale sweep wrote';exception when serialization_failure then null;end;
 if has_function_privilege('authenticated','preview_recurring_edit(uuid,date,frequency,time,date,date,date)','EXECUTE')
  or has_function_privilege('anon','quote_my_recurring_schedule(uuid,date,frequency,time,date,date)','EXECUTE') then raise exception 'private helper/anonymous write callable';end if;
end $$;
-- A new individually protected job invalidates the complete review; no partial
-- plan edit or fee is allowed. Expired reviews and malformed values fail too.
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
insert into series_test_state values('stale',quote_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1,'weekly','12:00',null,null));
reset role;
update jobs set started_at=clock_timestamp() where id=(select v#>>'{}' from series_test_state where k='job2')::uuid;
set local role authenticated;
do $$ begin
 begin perform confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(select (v->>'id')::uuid from series_test_state where k='stale'));raise exception 'started change not detected';exception when serialization_failure then null;end;
 begin perform quote_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date,'weekly','12:00',null,null);raise exception 'today anchor accepted';exception when invalid_parameter_value then null;end;
 begin perform quote_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1,'weekly','24:00',null,null);raise exception '24:00 accepted';exception when invalid_parameter_value then null;end;
end $$;
reset role;
-- No-op reviews do not release accepted contractors simply because a generated
-- job had no stored end time. Pause/end edits retain the literal skip dates.
reset role;
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date,start_time,horizon_days) values
 ('d9000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000001','standard','weekly',20000,90,(clock_timestamp() at time zone 'America/Chicago')::date+1,'09:30',21);
select materialise_recurring_job('d9000000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'America/Chicago')::date+1,recurring_start_at((clock_timestamp() at time zone 'America/Chicago')::date+1,'09:30'));
update cleaners set status='active' where id='d4000000-0000-0000-0000-000000000001';
insert into offers(id,job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at)
 select 'd6000000-0000-0000-0000-000000000002',id,'d4000000-0000-0000-0000-000000000001','open_board',2000,5000,.25,90,clock_timestamp()+interval '1 day' from jobs where recurring_plan_id='d9000000-0000-0000-0000-000000000002';
select respond_to_offer('d6000000-0000-0000-0000-000000000002','d4000000-0000-0000-0000-000000000001',true,null);
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000002';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;q jsonb;r jsonb;begin
 q:=quote_my_recurring_schedule(p,d,'weekly','09:30',null,null);
 if exists(select 1 from jsonb_array_elements(q->'review'->'visits') a where a->>'action'='moved') then raise exception 'identical generated terms marked moved';end if;
 r:=confirm_my_recurring_schedule(p,(q->>'id')::uuid);
end $$;
reset role;
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000002';begin
 if not exists(select 1 from job_assignments a join jobs j on j.id=a.job_id where j.recurring_plan_id=p) or exists(select 1 from recurring_schedule_releases x join jobs j on j.id=x.job_id where j.recurring_plan_id=p) then raise exception 'no-op released contractor';end if;
end $$;
insert into recurring_plan_skips(plan_id,occurrence_date) values('d9000000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'America/Chicago')::date+15);
set local role authenticated;
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000002';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;q jsonb;r jsonb;begin
 q:=quote_my_recurring_schedule(p,d,'weekly','10:30',d+7,d+14);
 if exists(select 1 from jsonb_array_elements(q->'review'->'visits') a where a->>'action'='added' or a->>'action'='moved') then raise exception 'pause/end/skip boundaries differ from generation';end if;
 r:=confirm_my_recurring_schedule(p,(q->>'id')::uuid);
end $$;
reset role;
do $$ declare p uuid:='d9000000-0000-0000-0000-000000000002';d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;r record;begin
 select * into r from materialise_recurring_job(p,d+7,recurring_start_at(d+7,'10:30'));
 if r.job_id is not null then raise exception 'pause endpoint generated';end if;
 select * into r from materialise_recurring_job(p,d+14,recurring_start_at(d+14,'10:30'));
 if r.job_id is not null then raise exception 'literal skip generated';end if;
 if (select count(*) from recurring_plan_skips where plan_id=p)<>1 then raise exception 'skip lost on edit';end if;
end $$;

-- Canceling an unmatched individual exception never skips a current-generation
-- occurrence. The client read and skip eligibility agree on that identity.
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
do $$ declare j uuid:=(select v#>>'{}' from series_test_state where k='job1')::uuid;q jsonb;r jsonb;begin
 if read_my_visit_schedule_identity(j)->>'recurring'<>'false' then raise exception 'old exception treated as current pattern';end if;
 begin perform quote_my_visit_cancellation(j,'skip');raise exception 'old exception can skip current series';exception when invalid_parameter_value then null;end;
 q:=quote_my_visit_cancellation(j,'cancel');r:=confirm_my_visit_cancellation(j,(q->>'id')::uuid);
 if r->>'fee_cents'<>'0' then raise exception 'future exception cancellation billed';end if;
end $$;
reset role;
do $$ begin
 if exists(select 1 from recurring_plan_skips where plan_id='d9000000-0000-0000-0000-000000000001') then raise exception 'exception cancellation suppressed new pattern';end if;
end $$;
-- Expired review remains retry-safe only after a receipt exists. An expired
-- unsaved quote cannot apply a plan edit.
set local role authenticated;
insert into series_test_state values('expired',quote_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'America/Chicago')::date+1,'weekly','12:00',null,null));
reset role;
update recurring_schedule_quotes set expires_at=clock_timestamp()-interval '1 second' where id=(select (v->>'id')::uuid from series_test_state where k='expired');
set local role authenticated;
do $$ begin
 begin perform confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(select (v->>'id')::uuid from series_test_state where k='expired'));raise exception 'expired review applied';exception when serialization_failure then null;end;
end $$;
reset role;

-- Office deactivation after a successful edit does not hide its receipt or
-- lose retry identity. Inactive patterns stay out of the active schedule list.
update recurring_plans set active=false where id='d9000000-0000-0000-0000-000000000001';
set local role authenticated;
do $$ declare rows jsonb;r jsonb;begin
 rows:=read_my_recurring_schedules('d9000000-0000-0000-0000-000000000001',null);
 if jsonb_array_length(rows)<>1 or rows->0->>'active'<>'false' then raise exception 'inactive history hidden';end if;
 if exists(select 1 from jsonb_array_elements(read_my_recurring_schedules(null,'d2000000-0000-0000-0000-000000000001')) p where p->>'id'='d9000000-0000-0000-0000-000000000001') then raise exception 'inactive plan in active list';end if;
 r:=confirm_my_recurring_schedule('d9000000-0000-0000-0000-000000000001',(select (v->>'id')::uuid from series_test_state where k='quote'));
 if r is distinct from (select v from series_test_state where k='receipt') then raise exception 'inactive retry changed historical receipt';end if;
end $$;
reset role;
rollback;
