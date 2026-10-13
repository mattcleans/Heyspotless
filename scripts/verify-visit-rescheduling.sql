-- Isolated fixtures; no real appointments, providers or payments.
begin;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated;
grant select on profiles,customers,properties,jobs,job_assignments to authenticated;
insert into auth.users(id,email) values
 ('91000000-0000-0000-0000-000000000001','move-a@example.test'),
 ('91000000-0000-0000-0000-000000000002','move-b@example.test'),
 ('91000000-0000-0000-0000-000000000003','move-admin@example.test'),
 ('91000000-0000-0000-0000-000000000004','move-cleaner@example.test');
update profiles set role='admin' where id='91000000-0000-0000-0000-000000000003';
update profiles set role='cleaner' where id='91000000-0000-0000-0000-000000000004';
insert into customers(id,profile_id,first_name,last_name) values
 ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','Move','A'),
 ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000002','Move','B');
insert into properties(id,customer_id,street,city,zip) values
 ('93000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','Sample A','Dallas','75001');
insert into cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared) values
 ('94000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000004','Cleaner','contractor_1099','active',4.5,true);
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date) values
 ('99000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','standard','weekly',20000,90,current_date+7);
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start,scheduled_end) select
 ('95000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '92000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,90,
 date_trunc('minute',clock_timestamp())+n*interval '7 days',date_trunc('minute',clock_timestamp())+n*interval '7 days'+interval '90 minutes' from generate_series(1,8) n;
update jobs set recurring_plan_id='99000000-0000-0000-0000-000000000001',occurrence_date=current_date+7,freq='weekly'
 where id='95000000-0000-0000-0000-000000000001';
-- Same appointment day and future start: rescheduling is still free.
update jobs set scheduled_start=date_trunc('minute',clock_timestamp())+interval '1 minute',scheduled_end=date_trunc('minute',clock_timestamp())+interval '91 minutes'
 where id='95000000-0000-0000-0000-000000000002';
update jobs set customer_id='92000000-0000-0000-0000-000000000002' where id='95000000-0000-0000-0000-000000000008';
insert into offers(id,job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at) values
 ('96000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','open_board',2000,5000,.25,90,clock_timestamp()+interval '1 day');
select respond_to_offer('96000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',true,null);
insert into invoices(id,job_id,customer_id,status,subtotal_cents,total_cents,amount_paid_cents) values
 ('97000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','paid',20000,20000,20000);
-- An inactive cleaner must not prevent releasing the original appointment.
update cleaners set status='paused' where id='94000000-0000-0000-0000-000000000001';
create temporary table move_test_quotes(kind text,q jsonb);
grant all on move_test_quotes to authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ declare q jsonb;r jsonb;target timestamptz:=date_trunc('minute',clock_timestamp())+interval '8 days';begin
 begin perform quote_my_visit_reschedule('95000000-0000-0000-0000-000000000008',target);raise exception 'other client allowed';exception when insufficient_privilege then null;end;
 begin perform quote_my_visit_reschedule('95000000-0000-0000-0000-000000000001',now()-interval '1 day');raise exception 'past move allowed';exception when invalid_parameter_value then null;end;
 begin perform quote_my_visit_reschedule('95000000-0000-0000-0000-000000000001',now()+interval '2 years');raise exception 'unbounded move allowed';exception when invalid_parameter_value then null;end;
 q:=quote_my_visit_reschedule('95000000-0000-0000-0000-000000000001',target);
 if q->>'fee_cents'<>'0' or q->>'released_count'<>'1' or q ? 'assignment_snapshot' then raise exception 'quote fee/count/privacy incorrect';end if;
 if (select status from jobs where id='95000000-0000-0000-0000-000000000001')<>'assigned' then raise exception 'review moved appointment';end if;
 r:=confirm_my_visit_reschedule('95000000-0000-0000-0000-000000000001',(q->>'id')::uuid);
 if r->>'fee_cents'<>'0' or r->>'price_cents'<>'20000' or (r->>'new_start')::timestamptz<>target then raise exception 'bad reschedule receipt';end if;
 if confirm_my_visit_reschedule('95000000-0000-0000-0000-000000000001',(q->>'id')::uuid)<>r then raise exception 'retry result changed';end if;
 begin perform 1 from visit_reschedule_quotes;raise exception 'private quote snapshots readable';exception when insufficient_privilege then null;end;
 if (select count(*) from visit_reschedule_releases)<>0 then raise exception 'client sees private cleaner pay';end if;
 q:=quote_my_visit_reschedule('95000000-0000-0000-0000-000000000002',date_trunc('minute',clock_timestamp())+interval '2 minutes');
 r:=confirm_my_visit_reschedule('95000000-0000-0000-0000-000000000002',(q->>'id')::uuid);
 if r->>'fee_cents'<>'0' then raise exception 'appointment day move charged';end if;
 insert into move_test_quotes values
  ('expired',quote_my_visit_reschedule('95000000-0000-0000-0000-000000000003',target)),
  ('started',quote_my_visit_reschedule('95000000-0000-0000-0000-000000000004',target)),
  ('assignment',quote_my_visit_reschedule('95000000-0000-0000-0000-000000000005',target)),
  ('revision',quote_my_visit_reschedule('95000000-0000-0000-0000-000000000006',target)),
  ('cancel',quote_my_visit_cancellation('95000000-0000-0000-0000-000000000006','cancel')),
  ('canceled',quote_my_visit_reschedule('95000000-0000-0000-0000-000000000007',target));
end $$;
reset role;
do $$ declare j jobs%rowtype;r record;begin
 select * into j from jobs where id='95000000-0000-0000-0000-000000000001';
 if j.status<>'scheduled' or j.occurrence_date<>current_date+7 or j.recurring_plan_id<>'99000000-0000-0000-0000-000000000001' or j.price_cents<>20000 or j.scheduled_end-j.scheduled_start<>interval '90 minutes' then raise exception 'visit identity/price/duration changed';end if;
 if exists(select 1 from job_assignments where job_id=j.id) then raise exception 'old assignment retained';end if;
 if (select status from offers where job_id=j.id)<>'withdrawn' then raise exception 'old accepted offer retained';end if;
 if (select count(*) from visit_reschedule_releases where job_id=j.id and payout_cents=5000)<>1 then raise exception 'agreed pay lost or duplicated';end if;
 if (select count(*) from invoices where job_id=j.id)<>1 or (select amount_paid_cents from invoices where job_id=j.id)<>20000 then raise exception 'billing changed or fee invoice created';end if;
 select * into r from materialise_recurring_job(j.recurring_plan_id,j.occurrence_date,now()+interval '7 days');
 if r.job_id<>j.id or r.created then raise exception 'original recurring slot recreated';end if;
 if start_job(j.id,'94000000-0000-0000-0000-000000000001') then raise exception 'released cleaner started';end if;
 if record_offer_for_schedule(j.id,'94000000-0000-0000-0000-000000000001',null,'open_board',1,.25,5000,90,now()+interval '1 day',false,j.schedule_revision-1) is not null then raise exception 'stale sweep offered';end if;
 if assign_job_for_schedule(j.id,'94000000-0000-0000-0000-000000000001',5000,j.schedule_revision-1) then raise exception 'stale sweep assigned';end if;
end $$;
update visit_reschedule_quotes set expires_at=now()-interval '1 second' where id=(select (q->>'id')::uuid from move_test_quotes where kind='expired');
update jobs set started_at=now(),status='in_progress' where id='95000000-0000-0000-0000-000000000004';
insert into job_assignments(job_id,cleaner_id,payout_cents) values('95000000-0000-0000-0000-000000000005','94000000-0000-0000-0000-000000000001',5000);
-- Move away and back; timestamp-only checks would miss this stale review.
update jobs set scheduled_start=scheduled_start+interval '1 hour' where id='95000000-0000-0000-0000-000000000006';
update jobs set scheduled_start=scheduled_start-interval '1 hour' where id='95000000-0000-0000-0000-000000000006';
update jobs set status='canceled' where id='95000000-0000-0000-0000-000000000007';
set local role authenticated;
do $$ declare r record;begin
 for r in select * from move_test_quotes where kind<>'cancel' loop
  begin perform confirm_my_visit_reschedule((r.q->>'job_id')::uuid,(r.q->>'id')::uuid);raise exception 'stale % confirmation allowed',r.kind;exception when sqlstate 'PT409' then null;end;
 end loop;
 begin perform confirm_my_visit_cancellation('95000000-0000-0000-0000-000000000006',(select (q->>'id')::uuid from move_test_quotes where kind='cancel'));raise exception 'stale cancellation after move-back allowed';exception when sqlstate 'PT409' then null;end;
 if (select status from jobs where id='95000000-0000-0000-0000-000000000006')='canceled' then raise exception 'failed cancellation did not roll back';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from visit_reschedules) then raise exception 'other client reads receipt';end if;
 begin perform confirm_my_visit_reschedule('95000000-0000-0000-0000-000000000003',(select (q->>'id')::uuid from move_test_quotes where kind='expired'));raise exception 'other client confirms review';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000004',true);
set local role authenticated;
do $$ begin
 if (select count(*) from visit_reschedule_releases)<>1 then raise exception 'released cleaner cannot see own change';end if;
 if exists(select 1 from visit_reschedules) then raise exception 'cleaner sees client receipts';end if;
 begin perform quote_my_visit_reschedule('95000000-0000-0000-0000-000000000001',now()+interval '9 days');raise exception 'cleaner moves visit';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform quote_my_visit_reschedule('95000000-0000-0000-0000-000000000001',now()+interval '9 days');raise exception 'anonymous moves visit';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ declare q jsonb;begin
 q:=quote_my_visit_reschedule('95000000-0000-0000-0000-000000000008',date_trunc('minute',clock_timestamp())+interval '9 days');
 perform confirm_my_visit_reschedule('95000000-0000-0000-0000-000000000008',(q->>'id')::uuid);
 if (select count(*) from visit_reschedule_releases)<>1 then raise exception 'office private history inaccessible';end if;
end $$;
reset role;
rollback;
