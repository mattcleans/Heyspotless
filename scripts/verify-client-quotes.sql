-- Full-schema regression, fictional accounts, rolled back after verification.
begin;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated;
grant select,insert,update,delete on quotes,quote_line_items to authenticated;
grant select on price_book_items,price_book_rates to authenticated;
insert into auth.users(id,email) select ('c8100000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'quotes-'||n||'@example.test' from generate_series(1,4)n;
update profiles set role=case when right(id::text,12)::integer=1 then 'admin'::user_role when right(id::text,12)::integer in (2,3) then 'customer'::user_role else 'cleaner'::user_role end where id::text like 'c8100000-%';
insert into customers(id,profile_id,first_name,last_name,notes) values('c8200000-0000-0000-0000-000000000001','c8100000-0000-0000-0000-000000000002','Quote','Client','PRIVATE-OFFICE-NOTE');
insert into customers(id,profile_id,first_name,last_name) values('c8200000-0000-0000-0000-000000000002','c8100000-0000-0000-0000-000000000003','Other','Client');
insert into properties(id,customer_id,street,city,zip,bedrooms,bathrooms,gate_code) values('c8300000-0000-0000-0000-000000000001','c8200000-0000-0000-0000-000000000001','Quote Test Home','Dallas','75001',2,2,'PRIVATE-GATE');
create temporary table quote_test_saved(n integer primary key,q jsonb);
grant all on quote_test_saved to authenticated;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
insert into quote_test_saved select n,prepare_client_quote(('c8400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'c8300000-0000-0000-0000-000000000001','standard',case when n=2 then 'weekly'::frequency else 'one_time'::frequency end,
 date_trunc('day',clock_timestamp()+interval '30 days')+interval '15 hours',clock_timestamp()+interval '7 days',n=2,'[{"itemKey":"refrigerator","quantity":1}]','Client-facing note') from generate_series(1,6)n;
reset role;
-- Use real seeded extra name; asserted amounts are the saved complete terms.
do $$ declare q jsonb;begin
 select s.q into q from quote_test_saved s where n=1;
 if (q->>'totalCents')::integer<=20800 or jsonb_array_length(q->'lines')<>7 or q->>'state'<>'review' or q::text like '%PRIVATE-%' then raise exception 'Quote did not include extras or leaked private data';end if;
end $$;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if read_client_quotes()<>'[]'::jsonb or exists(select 1 from quotes where id::text like 'c8400000-%') or exists(select 1 from quote_line_items where quote_id::text like 'c8400000-%') then raise exception 'Unpublished quote visible';end if;
 begin perform publish_client_quote('c8400000-0000-0000-0000-000000000001');raise exception 'Customer published office quote';exception when insufficient_privilege then null;end;
 begin perform decide_client_quote('c8400000-0000-0000-0000-000000000001',uuid_generate_v4(),0,true);raise exception 'Customer decided private draft';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
update quote_test_saved set q=publish_client_quote((q->>'id')::uuid);
do $$ declare q jsonb;begin
 select s.q into q from quote_test_saved s where n=1;
 if publish_client_quote((q->>'id')::uuid)<>q then raise exception 'Publish retry changed quote';end if;
 begin perform book_client_quote((q->>'id')::uuid,(q->>'version')::integer);raise exception 'Office booked without client approval';exception when sqlstate 'PT409' then null;end;
 begin update quotes set total_cents=1 where id=(q->>'id')::uuid;raise exception 'Direct quote price changed';exception when insufficient_privilege then null;end;
 begin update quotes set client_managed=false where id=(q->>'id')::uuid;raise exception 'Direct guard flag changed';exception when insufficient_privilege then null;end;
 begin update quote_line_items set name='tampered' where quote_id=(q->>'id')::uuid;raise exception 'Direct line changed';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
 if read_client_quotes()<>'[]'::jsonb then raise exception 'Other customer read quote';end if;
 begin perform decide_client_quote('c8400000-0000-0000-0000-000000000001',uuid_generate_v4(),1,true);raise exception 'Other customer decided quote';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000004',true);
set local role authenticated;
do $$ begin begin perform read_client_quotes();raise exception 'Cleaner read quotes';exception when insufficient_privilege then null;end;end $$;
reset role;
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',true);
set local role authenticated;
update quote_test_saved set q=decide_client_quote((q->>'id')::uuid,('c8500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,(q->>'version')::integer,true) where n in (1,2,3,4,5);
do $$ declare r jsonb;begin
 r:=decide_client_quote('c8400000-0000-0000-0000-000000000001','c8500000-0000-0000-0000-000000000001',1,true);
 if r is distinct from (select q from quote_test_saved where n=1) then raise exception 'Decision retry changed receipt';end if;
 begin perform decide_client_quote('c8400000-0000-0000-0000-000000000001','c8500000-0000-0000-0000-000000000001',1,false);raise exception 'Reused request changed decision';exception when sqlstate 'PT409' then null;end;
end $$;
update quote_test_saved set q=decide_client_quote((q->>'id')::uuid,uuid_generate_v4(),(q->>'version')::integer,false) where n=3;
reset role;
-- Price book edits after acceptance cannot change the saved customer agreement.
update price_book_rates set price_cents=price_cents+500 where freq='weekly';
update price_book_extras set price_cents=price_cents+5000 where item_key='refrigerator';
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ declare q jsonb;r jsonb;begin
 select s.q into q from quote_test_saved s where n=3;
 begin perform book_client_quote((q->>'id')::uuid,(q->>'version')::integer-1);raise exception 'Stale acceptance booked';exception when sqlstate 'PT409' then null;end;
 for q in select s.q from quote_test_saved s where n in (1,2) loop
  r:=book_client_quote((q->>'id')::uuid,(q->>'version')::integer);
  if r->>'state'<>'booked' or r->>'jobId' is null or r->>'totalCents'<>q->>'totalCents' then raise exception 'Booking changed accepted terms';end if;
  if book_client_quote((q->>'id')::uuid,(q->>'version')::integer)<>r then raise exception 'Booking retry changed result';end if;
 end loop;
end $$;
reset role;
do $$ begin
 if (select count(*) from jobs where quote_id::text like 'c8400000-%')<>2 or (select count(*) from recurring_plans where property_id='c8300000-0000-0000-0000-000000000001')<>1 then raise exception 'Missing or duplicate booking';end if;
 if exists(select 1 from jobs j join quotes q on q.id=j.quote_id where j.quote_id::text like 'c8400000-%' and (j.price_cents<>q.total_cents or j.estimated_clean_minutes<>q.estimated_minutes or j.notes not like '%Refrigerator%')) then raise exception 'Agreed price/minutes/extras lost';end if;
 if exists(select 1 from invoices where customer_id='c8200000-0000-0000-0000-000000000001') or exists(select 1 from job_assignments where job_id in(select id from jobs where quote_id::text like 'c8400000-%')) then raise exception 'Quote booked a charge or cleaner';end if;
end $$;
-- Frequency changes keep accepted extras in the new total and duration.
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ declare v_plan uuid;r jsonb;b record;begin
 v_plan:=(select (x->>'planId')::uuid from jsonb_array_elements(read_client_quotes()) x where x->>'id'='c8400000-0000-0000-0000-000000000002');
 r:=quote_my_recurring_schedule(v_plan,(clock_timestamp() at time zone 'America/Chicago')::date+30,'biweekly','09:00',null,null);
 select * into b from quote_price('standard','biweekly',2,2,0,1,1,1);
 if (r->'review'->>'price_cents')::integer<>b.total_cents+2500 or (r->'review'->>'estimated_minutes')::integer<>b.clean_minutes+20 then raise exception 'Frequency review lost accepted extras';end if;
 perform confirm_my_recurring_schedule(v_plan,(r->>'id')::uuid);
end $$;
reset role;

-- Property changes and expiry block booking; withdrawal remains available.
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
update properties set bedrooms=3 where id='c8300000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 begin perform book_client_quote('c8400000-0000-0000-0000-000000000004',2);raise exception 'Changed home booked';exception when sqlstate 'PT409' then null;end;
 perform withdraw_client_quote('c8400000-0000-0000-0000-000000000004');
 if withdraw_client_quote('c8400000-0000-0000-0000-000000000004')->>'state'<>'withdrawn' then raise exception 'Withdraw retry failed';end if;
end $$;
reset role;
update properties set bedrooms=2 where id='c8300000-0000-0000-0000-000000000001';
update spotless_private.client_quote_terms set expires_at=clock_timestamp()-interval '1 second' where id='c8400000-0000-0000-0000-000000000005';
select set_config('request.jwt.claim.sub','c8100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin begin perform book_client_quote('c8400000-0000-0000-0000-000000000005',2);raise exception 'Expired quote booked';exception when sqlstate 'PT409' then null;end;end $$;
reset role;
do $$ declare f text;begin
 foreach f in array array['read_client_quotes(uuid)','prepare_client_quote(uuid,uuid,service_type,frequency,timestamptz,timestamptz,boolean,jsonb,text)','publish_client_quote(uuid)','decide_client_quote(uuid,uuid,integer,boolean)','withdraw_client_quote(uuid)','book_client_quote(uuid,integer)'] loop
  if has_function_privilege('anon',f,'EXECUTE') or has_function_privilege('service_role',f,'EXECUTE') or not has_function_privilege('authenticated',f,'EXECUTE') then raise exception 'Quote grants wrong: %',f;end if;
 end loop;
 if has_table_privilege('authenticated','spotless_private.client_quote_terms','SELECT') or has_table_privilege('authenticated','spotless_private.client_quote_decisions','INSERT') then raise exception 'Private quote terms exposed';end if;
 raise notice 'Client quote acceptance and office booking verified';
end $$;
rollback;
