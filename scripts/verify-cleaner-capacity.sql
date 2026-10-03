-- Disposable verification only. Every fixture and grant rolls back.
begin;
insert into customers(id,first_name,last_name) values('f2000000-0000-0000-0000-000000000001','Capacity','Client');
insert into properties(id,customer_id,street,city,zip) values('f3000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001','Capacity fixture','Dallas','75001');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared)
 select ('f4000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'Capacity Cleaner '||n,'contractor_1099','active',4.5,true from generate_series(1,2)n;
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start,scheduled_end)
 select ('f5000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'f2000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,90,
  case n when 1 then '2028-01-03 08:00Z'::timestamptz when 2 then '2028-01-03 08:30Z' when 3 then '2028-01-03 09:30Z' when 4 then '2028-01-03 12:00Z' when 5 then '2028-01-03 12:30Z' when 6 then '2028-01-03 15:00Z' when 7 then '2028-01-03 15:30Z' when 8 then '2028-01-03 08:15Z' when 9 then '2028-01-03 08:30Z' when 11 then 'infinity'::timestamptz else null end,
  case n when 2 then '2028-01-03 10:00Z'::timestamptz when 3 then '2028-01-03 11:00Z' when 4 then '2028-01-03 13:30Z' when 8 then '2028-01-03 09:00Z' when 9 then '2028-01-03 09:15Z' else null end
 from generate_series(1,11)n;
create temporary table capacity_test_offers(job_id uuid,id uuid);
insert into capacity_test_offers select id,record_offer(id,'f4000000-0000-0000-0000-000000000001',null,'open_board',1,0.4,8000,90,clock_timestamp()+interval '1 hour',false)
 from jobs where id in ('f5000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000002','f5000000-0000-0000-0000-000000000003');
do $$ declare o uuid;r text;begin
 select id into o from capacity_test_offers where job_id='f5000000-0000-0000-0000-000000000001';
 if respond_to_offer_with_capacity(o,'f4000000-0000-0000-0000-000000000002',true)<>'not_found' then raise exception 'Another cleaner answered the offer';end if;
 if respond_to_offer_with_capacity(o,'f4000000-0000-0000-0000-000000000001',true)<>'accepted' then raise exception 'First acceptance failed';end if;
 if (select payout_cents from job_assignments where job_id='f5000000-0000-0000-0000-000000000001')<>8000 then raise exception 'Accepted payout changed';end if;
 select id into o from capacity_test_offers where job_id='f5000000-0000-0000-0000-000000000002';
 if respond_to_offer_with_capacity(o,'f4000000-0000-0000-0000-000000000001',true)<>'conflict' then raise exception 'Estimated-end overlap accepted';end if;
 if respond_to_offer_with_capacity(o,'f4000000-0000-0000-0000-000000000001',false,'retry')<>'conflict' then raise exception 'Lost-response conflict retry changed outcome';end if;
 if not exists(select 1 from offers where id=o and status='withdrawn' and capacity_conflict_at is not null and decline_reason is null) then raise exception 'Conflict counted as a decline';end if;
 if exists(select 1 from job_assignments where job_id='f5000000-0000-0000-0000-000000000002') then raise exception 'Conflicting assignment survived rollback';end if;
 select id into o from capacity_test_offers where job_id='f5000000-0000-0000-0000-000000000003';
 if respond_to_offer(o,'f4000000-0000-0000-0000-000000000001',true)<>'accepted' then raise exception 'Adjacent visit rejected';end if;
end $$;
-- The assistant's capacity is reserved even when another cleaner is lead.
insert into job_assignments(job_id,cleaner_id,is_lead,payout_cents) values
 ('f5000000-0000-0000-0000-000000000004','f4000000-0000-0000-0000-000000000001',false,5000),
 ('f5000000-0000-0000-0000-000000000004','f4000000-0000-0000-0000-000000000002',true,5000),
 ('f5000000-0000-0000-0000-000000000006','f4000000-0000-0000-0000-000000000001',true,5000),
 ('f5000000-0000-0000-0000-000000000007','f4000000-0000-0000-0000-000000000002',true,5000);
do $$ begin
 begin insert into job_assignments(job_id,cleaner_id,payout_cents) values('f5000000-0000-0000-0000-000000000005','f4000000-0000-0000-0000-000000000001',5000);raise exception 'Crew assistant double booked';exception when sqlstate 'PCP01' then null;end;
 begin update jobs set scheduled_start='2028-01-03 12:30Z',scheduled_end='2028-01-03 14:00Z' where id='f5000000-0000-0000-0000-000000000001';raise exception 'Assigned window moved onto crew';exception when sqlstate 'PCP01' then null;end;
 begin update jobs set estimated_clean_minutes=300 where id='f5000000-0000-0000-0000-000000000001';raise exception 'Missing-end duration extension overlapped adjacent visit';exception when sqlstate 'PCP01' then null;end;
 begin update jobs set scheduled_end='2028-01-03 16:00Z' where id='f5000000-0000-0000-0000-000000000004';raise exception 'Crew end extension double booked';exception when sqlstate 'PCP01' then null;end;
 begin update job_assignments set job_id='f5000000-0000-0000-0000-000000000005' where job_id='f5000000-0000-0000-0000-000000000001';raise exception 'Assignment transfer double booked';exception when sqlstate 'PCP01' then null;end;
 begin update job_assignments set cleaner_id='f4000000-0000-0000-0000-000000000002' where job_id='f5000000-0000-0000-0000-000000000006';raise exception 'Cleaner substitution double booked';exception when sqlstate 'PCP01' then null;end;
 if (select scheduled_start from jobs where id='f5000000-0000-0000-0000-000000000001')<>'2028-01-03 08:00Z'::timestamptz or (select estimated_clean_minutes from jobs where id='f5000000-0000-0000-0000-000000000001')<>90 then raise exception 'Rejected window change left writes';end if;
 if (select count(*) from job_assignments where job_id='f5000000-0000-0000-0000-000000000004')<>2 then raise exception 'Crew conflict dropped a teammate';end if;
end $$;
update jobs set status='complete' where id='f5000000-0000-0000-0000-000000000001';
insert into job_assignments(job_id,cleaner_id,payout_cents) values('f5000000-0000-0000-0000-000000000008','f4000000-0000-0000-0000-000000000001',5000);
update jobs set status='canceled' where id='f5000000-0000-0000-0000-000000000008';
insert into job_assignments(job_id,cleaner_id,payout_cents) values
 ('f5000000-0000-0000-0000-000000000009','f4000000-0000-0000-0000-000000000001',5000),
 ('f5000000-0000-0000-0000-000000000010','f4000000-0000-0000-0000-000000000001',5000);
do $$ begin
 begin update jobs set scheduled_start='2028-01-03 08:30Z' where id='f5000000-0000-0000-0000-000000000010';raise exception 'Undated assignment became overlapping';exception when sqlstate 'PCP01' then null;end;
 begin update jobs set status='scheduled' where id='f5000000-0000-0000-0000-000000000001';raise exception 'Reopened completion double booked';exception when sqlstate 'PCP01' then null;end;
 begin insert into job_assignments(job_id,cleaner_id,payout_cents) values('f5000000-0000-0000-0000-000000000011','f4000000-0000-0000-0000-000000000001',5000);raise exception 'Infinite appointment assigned';exception when invalid_parameter_value then null;end;
 if exists(select 1 from job_assignments a join job_assignments b on a.cleaner_id=b.cleaner_id and a.job_id<b.job_id
  join jobs j on j.id=a.job_id join jobs k on k.id=b.job_id where a.cleaner_id::text like 'f4000000-%'
   and j.status not in ('complete','canceled') and k.status not in ('complete','canceled')
   and spotless_private.visit_capacity_window(j.scheduled_start,j.scheduled_end,j.estimated_clean_minutes)
    && spotless_private.visit_capacity_window(k.scheduled_start,k.scheduled_end,k.estimated_clean_minutes)) then raise exception 'Active fixture still double booked';end if;
 if not (select relrowsecurity from pg_class where oid='spotless_private.cleaner_capacity'::regclass) then raise exception 'Capacity table lacks RLS';end if;
 if has_schema_privilege('anon','spotless_private','USAGE') or has_schema_privilege('authenticated','spotless_private','USAGE') or has_schema_privilege('service_role','spotless_private','USAGE') then raise exception 'Private capacity schema exposed';end if;
 if has_function_privilege('authenticated','public.respond_to_offer_with_capacity(uuid,uuid,boolean,text)','EXECUTE') or has_function_privilege('anon','public.assign_job_for_schedule_with_capacity(uuid,uuid,integer,bigint)','EXECUTE') then raise exception 'Server write exposed to clients';end if;
end $$;
-- Capacity releases on deletion and respects existing cascade behavior.
delete from job_assignments where job_id='f5000000-0000-0000-0000-000000000009';
update jobs set scheduled_start='2028-01-03 08:30Z',estimated_clean_minutes=30 where id='f5000000-0000-0000-0000-000000000010';
delete from cleaners where id='f4000000-0000-0000-0000-000000000001';
do $$ begin
 if exists(select 1 from spotless_private.cleaner_capacity where cleaner_id='f4000000-0000-0000-0000-000000000001') or exists(select 1 from job_assignments where cleaner_id='f4000000-0000-0000-0000-000000000001') then raise exception 'Cleaner cascade broke capacity release';end if;
 raise notice 'Cleaner capacity: offers, retries, crew assistants, window edits, transfers, releases and private access verified';
end $$;
rollback;
