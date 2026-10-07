-- Disposable database: fictional accounts and all mutations rolled back.
begin;
grant usage on schema public,auth,spotless_private to authenticated;
grant execute on function auth.uid() to authenticated;
insert into auth.users(id,email) select ('c9100000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'booking-'||n||'@example.test' from generate_series(1,4)n;
update profiles set role=case when right(id::text,12)::integer=3 then 'cleaner'::user_role when right(id::text,12)::integer=4 then 'admin'::user_role else 'customer'::user_role end where id::text like 'c9100000-%';
insert into customers(id,profile_id,first_name,last_name) values
 ('c9200000-0000-0000-0000-000000000001','c9100000-0000-0000-0000-000000000001','Booking','Client'),
 ('c9200000-0000-0000-0000-000000000002','c9100000-0000-0000-0000-000000000002','Other','Client');
insert into properties(id,customer_id,street,city,zip,bedrooms,bathrooms,gate_code,access_notes) values
 ('c9300000-0000-0000-0000-000000000001','c9200000-0000-0000-0000-000000000001','Owned Booking Test Home','Dallas','75201',2,2,'PRIVATE-GATE','PRIVATE-ACCESS');
create temporary table booking_test_saved(n integer primary key,q jsonb);
grant all on booking_test_saved to authenticated;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
insert into booking_test_saved select n,review_my_booking(('c9400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'c9300000-0000-0000-0000-000000000001','standard',case when n=2 then 'biweekly'::frequency else 'one_time'::frequency end,
 date_trunc('day',now()+interval '30 days')+interval '15 hours'+make_interval(days=>(n-1)*4),n=2,'[{"itemKey":"oven","quantity":1}]','Synthetic booking notes') from generate_series(1,5)n;
do $$ declare q jsonb;begin
 select s.q into q from booking_test_saved s where n=1;
 if q->>'state'<>'review' or (q->>'totalCents')::integer<>24900 or (q->>'estimatedMinutes')::integer<>168
 or q->>'jobId' is not null or q->>'planId' is not null or q::text like '%PRIVATE-%' then raise exception 'Wrong owned price review or private data leak';end if;
 if (select (s.q->>'totalCents')::integer from booking_test_saved s where n=2)<>22000 then raise exception 'Recurring rate discounted the oven extra';end if;
 if has_function_privilege('anon','public.review_my_booking(uuid,uuid,service_type,frequency,timestamptz,boolean,jsonb,text)','execute')
 or has_function_privilege('anon','public.confirm_my_booking(uuid)','execute')
 or has_function_privilege('authenticated','spotless_private.price_saved_home(uuid,service_type,frequency,jsonb)','execute') then raise exception 'Unexpected booking privilege';end if;
end $$;
reset role;
-- Reviews hold their exact price even if the price book changes before retry.
update price_book_rates set price_cents=price_cents+100 where item_id=(select id from price_book_items where service='standard' and item_key='arrival');
set local role authenticated;
do $$ declare q jsonb;begin
 q:=review_my_booking('c9400000-0000-0000-0000-000000000001','c9300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',now()+interval '30 days')+interval '15 hours',false,'[{"itemKey":"oven","quantity":1}]','Synthetic booking notes');
 if (q->>'totalCents')::integer<>24900 then raise exception 'Review retry repriced saved terms';end if;
 begin
  perform review_my_booking('c9400000-0000-0000-0000-000000000001','c9300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',now()+interval '30 days')+interval '15 hours',false,'[]','Different request');
  raise exception 'Changed body reused immutable review';
 exception when sqlstate 'PT409' then null;end;
 update booking_test_saved s set q=confirm_my_booking((s.q->>'id')::uuid) where s.n in (1,2);
 for q in select s.q from booking_test_saved s where n in (1,2) loop
  if q->>'state'<>'requested' or q->>'jobId' is null then raise exception 'Missing saved request identity';end if;
  if confirm_my_booking((q->>'id')::uuid)<>q then raise exception 'Confirmation retry changed result';end if;
 end loop;
end $$;
reset role;
do $$ declare j jobs%rowtype;p recurring_plans%rowtype;begin
 select * into j from jobs where id=(select (q->>'jobId')::uuid from booking_test_saved where n=1);
 if j.status<>'scheduled' or j.price_cents<>24900 or j.recurring_plan_id is not null or j.notes not like '%Oven Clean × 1%Synthetic booking notes%' then raise exception 'One-time request lost terms or silently repeated';end if;
 select * into p from recurring_plans where id=(select (q->>'planId')::uuid from booking_test_saved where n=2);
 if p.id is null or p.freq<>'biweekly' or p.agreed_price_cents<>22000 or not p.active
 or (p.quote_extras->0->>'itemKey')<>'oven' or (p.quote_extras->0->>'totalCents')::integer<>5000 then raise exception 'Recurring request lost saved extra or price';end if;
 perform materialise_recurring_job(p.id,p.anchor_date+14,recurring_start_at(p.anchor_date+14,p.start_time));
 if (select count(*) from jobs where recurring_plan_id=p.id)<>2
 or exists(select 1 from jobs where recurring_plan_id=p.id and (price_cents<>22000 or estimated_clean_minutes<>168 or notes not like '%Oven Clean × 1%')) then raise exception 'Future occurrence lost accepted terms';end if;
 if exists(select 1 from invoices where job_id in(select (q->>'jobId')::uuid from booking_test_saved))
 or exists(select 1 from job_assignments where job_id in(select (q->>'jobId')::uuid from booking_test_saved)) then raise exception 'Booking charged or assigned without separate matching';end if;
end $$;
-- A second review for an already requested time cannot create a duplicate visit.
set local role authenticated;
do $$ declare q jsonb;begin
 q:=review_my_booking('c9400000-0000-0000-0000-000000000006','c9300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',now()+interval '30 days')+interval '15 hours',false,'[]','Duplicate time');
 begin perform confirm_my_booking((q->>'id')::uuid);raise exception 'Overlapping home request succeeded';exception when sqlstate 'PBO01' then null;end;
end $$;
reset role;
update properties set bedrooms=3 where id='c9300000-0000-0000-0000-000000000001';
set local role authenticated;
do $$ begin
 begin perform confirm_my_booking('c9400000-0000-0000-0000-000000000003');raise exception 'Changed home was booked';exception when sqlstate 'PT409' then null;end;
 if not exists(select 1 from jsonb_array_elements(read_my_booking_reviews()) r where r->>'id'='c9400000-0000-0000-0000-000000000003' and r->>'state'='stale') then raise exception 'Stale home review not explained';end if;
end $$;
reset role;
update properties set bedrooms=2 where id='c9300000-0000-0000-0000-000000000001';
update spotless_private.client_booking_reviews set expires_at=clock_timestamp()-interval '1 second' where id='c9400000-0000-0000-0000-000000000004';
set local role authenticated;
do $$ begin
 begin perform confirm_my_booking('c9400000-0000-0000-0000-000000000004');raise exception 'Expired review was booked';exception when sqlstate 'PT409' then null;end;
end $$;
reset role;
-- Canceled or removed results are recovered, never recreated by a retry.
update jobs set status='canceled' where id=(select (q->>'jobId')::uuid from booking_test_saved where n=1);
set local role authenticated;
do $$ begin if confirm_my_booking('c9400000-0000-0000-0000-000000000001')->>'state'<>'canceled' then raise exception 'Canceled outcome was recreated';end if;end $$;
reset role;
delete from jobs where id=(select (q->>'jobId')::uuid from booking_test_saved where n=1);
set local role authenticated;
do $$ begin if confirm_my_booking('c9400000-0000-0000-0000-000000000001')->>'state'<>'unavailable' then raise exception 'Deleted outcome was recreated';end if;end $$;
reset role;
-- Actual trusted roles, not editable metadata, decide access.
do $$ declare actor uuid;begin
 for actor in select ('c9100000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid from generate_series(2,4)n loop
  perform set_config('request.jwt.claim.sub',actor::text,true);
  set local role authenticated;
  begin perform confirm_my_booking('c9400000-0000-0000-0000-000000000005');raise exception 'Foreign review was confirmed';exception when insufficient_privilege then null;end;
  begin perform review_my_booking(gen_random_uuid(),'c9300000-0000-0000-0000-000000000001','standard','one_time',date_trunc('day',now()+interval '90 days'),false,'[]','');raise exception 'Foreign home was reviewed';exception when insufficient_privilege then null;end;
  if public.current_role_of()='customer' then
   if read_my_booking_reviews()<>'[]'::jsonb then raise exception 'Foreign history disclosed';end if;
  else begin perform read_my_booking_reviews();raise exception 'Wrong role read booking history';exception when insufficient_privilege then null;end;end if;
  reset role;
 end loop;
end $$;
-- Defense in depth survives an accidental broad table grant.
grant select,insert,update,delete on spotless_private.client_booking_reviews,spotless_private.client_booking_home_locks to authenticated;
select set_config('request.jwt.claim.sub','c9100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 if (select count(*) from spotless_private.client_booking_reviews)<>0 then raise exception 'Private review table bypassed RLS';end if;
 begin insert into spotless_private.client_booking_home_locks values('c9300000-0000-0000-0000-000000000001');raise exception 'Private lock inserted directly';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ begin begin perform read_my_booking_reviews();raise exception 'Unsigned access succeeded';exception when insufficient_privilege then null;end;end $$;
rollback;
