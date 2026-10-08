-- Disposable database only: every fixture and outcome rolls back.
begin;
insert into customers(id,first_name,last_name) values('db120000-0000-4000-8000-000000000001','Appointment','Client');
insert into properties(id,customer_id,street,city,zip) values('db130000-0000-4000-8000-000000000001','db120000-0000-4000-8000-000000000001','Synthetic appointment home','Dallas','75001');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared)
values('db140000-0000-4000-8000-000000000001','Appointment contractor','contractor_1099','active',4.5,true),
 ('db140000-0000-4000-8000-000000000002','Appointment employee','w2_core','active',4.5,true);
update public.cleaners set hourly_rate_cents=2175,guaranteed_hours_per_week=30 where id='db140000-0000-4000-8000-000000000002';
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
select ('db150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'db120000-0000-4000-8000-000000000001','db130000-0000-4000-8000-000000000001','scheduled','standard','one_time',20000,30,
 case n when 1 then null when 2 then clock_timestamp()-interval '1 hour' when 3 then 'infinity'::timestamptz
 when 8 then clock_timestamp() else clock_timestamp()+make_interval(hours=>n) end from generate_series(1,8)n;
do $test$
declare job uuid;o uuid;r text;
begin
 for job in select id from public.jobs where id in ('db150000-0000-4000-8000-000000000001','db150000-0000-4000-8000-000000000002','db150000-0000-4000-8000-000000000003','db150000-0000-4000-8000-000000000008') loop
  if public.record_offer_for_schedule(job,'db140000-0000-4000-8000-000000000001',null,'open_board',1,.4,8000,30,clock_timestamp()+interval '1 hour',false,1) is not null then raise exception 'Unusable appointment offered';end if;
  if public.assign_job_for_schedule_with_capacity(job,'db140000-0000-4000-8000-000000000002',8000,1) then raise exception 'Unusable appointment assigned';end if;
  if exists(select 1 from public.offers where job_id=job) or exists(select 1 from public.job_assignments where job_id=job) then raise exception 'Refused time left an offer or assignment';end if;
 end loop;
 insert into public.dispatch_decisions(job_id,kind,continuity_reason,rationale)
 values('db150000-0000-4000-8000-000000000002','needs_scheduling','appointment_requires_review','Review appointment');
 o:=public.record_offer_for_schedule('db150000-0000-4000-8000-000000000004','db140000-0000-4000-8000-000000000001',null,'open_board',1,.4,8000,30,clock_timestamp()+interval '8 hours',false,1);
 if o is null or (select expires_at from public.offers where id=o) is distinct from (select scheduled_start from public.jobs where id='db150000-0000-4000-8000-000000000004') then raise exception 'Offer deadline outlived appointment';end if;
 if public.respond_to_offer_with_capacity(o,'db140000-0000-4000-8000-000000000001',true)<>'accepted' then raise exception 'Future offer was not accepted';end if;
 -- Accepted history keeps its recorded agreement and established already-answered response.
 update public.jobs set scheduled_start=clock_timestamp()-interval '1 day' where id='db150000-0000-4000-8000-000000000004';
 if public.respond_to_offer_with_capacity(o,'db140000-0000-4000-8000-000000000001',true)<>'superseded'
 or (select status from public.offers where id=o)<>'accepted'
 or (select count(*) from public.job_assignments where job_id='db150000-0000-4000-8000-000000000004')<>1
 or (select payout_cents from public.job_assignments where job_id='db150000-0000-4000-8000-000000000004')<>8000 then raise exception 'Accepted history or retry outcome changed';end if;
 -- A legacy live countdown must not claim an appointment after it passes.
 update public.jobs set scheduled_start=clock_timestamp()+interval '500 milliseconds' where id='db150000-0000-4000-8000-000000000006';
 o:=public.record_offer('db150000-0000-4000-8000-000000000006','db140000-0000-4000-8000-000000000001',null,'open_board',1,.4,8000,30,clock_timestamp()+interval '5 minutes',false);
 perform pg_sleep(.6);
 if public.respond_to_offer_with_capacity(o,'db140000-0000-4000-8000-000000000001',true)<>'expired'
 or exists(select 1 from public.job_assignments where job_id='db150000-0000-4000-8000-000000000006')
 or (select status from public.offers where id=o)<>'expired' then raise exception 'Passed appointment accepted';end if;
 if not public.assign_job_for_schedule_with_capacity('db150000-0000-4000-8000-000000000007','db140000-0000-4000-8000-000000000002',8000,1) then raise exception 'Future employee assignment refused';end if;
 if has_function_privilege('authenticated','public.record_offer_for_schedule(uuid,uuid,uuid,dispatch_channel,integer,numeric,integer,integer,timestamptz,boolean,bigint)','execute')
 or has_function_privilege('anon','public.assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint)','execute') then raise exception 'Server matching access widened';end if;
 raise notice 'Appointment readiness: missing/past/nonfinite/boundary refusal, deadline clamp, accepted retry and actual time passage passed';
end $test$;
rollback;
