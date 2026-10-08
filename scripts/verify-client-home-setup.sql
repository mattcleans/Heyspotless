-- Disposable verification database only. All actors and outcomes roll back.
begin;
grant usage on schema public,auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant select on profiles,customers,properties,jobs to authenticated;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('d9100000-0000-4000-8000-000000000001','new-home-client@example.test',now(),'{"role":"admin"}'),
 ('d9100000-0000-4000-8000-000000000002','unconfirmed-home@example.test',null,'{}'),
 ('d9100000-0000-4000-8000-000000000003','existing-home@example.test',now(),'{}'),
 ('d9100000-0000-4000-8000-000000000004','other-home-client@example.test',now(),'{}');
insert into customers(id,first_name,last_name,email) values('d9200000-0000-4000-8000-000000000003','Existing','Client','existing-home@example.test');
create temporary table home_setup_results(result jsonb);
grant all on home_setup_results to authenticated;
do $$ begin
 if (select role from profiles where id='d9100000-0000-4000-8000-000000000001')<>'customer' then raise exception 'Signup metadata granted staff access'; end if;
 if has_function_privilege('anon','public.save_my_home(uuid,jsonb,jsonb)','execute')
   or has_table_privilege('authenticated','spotless_private.client_home_setups','select') then raise exception 'Home ledger exposed'; end if;
end $$;
select set_config('request.jwt.claim.sub','d9100000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into home_setup_results select save_my_home('d9300000-0000-4000-8000-000000000001',
 '{"street":"100 Synthetic Setup Way","city":"Dallas","state":"TX","zip":"75201","bedrooms":2,"bathrooms":2,"halfBaths":0,"kitchens":1,"livingRooms":1,"utilityRooms":1}',
 '{"firstName":"Synthetic","lastName":"Client","phone":"469-555-0100"}');
do $$ declare h jsonb; r jsonb; b jsonb; v_customer uuid; v_property uuid; begin
 select result into r from home_setup_results; h:=r->'home';v_customer:=(r->>'customerId')::uuid;v_property:=(r->>'id')::uuid;
 if (select email from customers where id=v_customer)<>'new-home-client@example.test' then raise exception 'Email not derived from verified Auth'; end if;
 if (select count(*) from properties where customer_id=v_customer)<>1 then raise exception 'Home not readable through caller RLS'; end if;
 if save_my_home('d9300000-0000-4000-8000-000000000001',h,'{"firstName":"Synthetic","lastName":"Client","phone":"469-555-0100"}')<>r then raise exception 'Same request retry changed home';end if;
 if save_my_home('d9300000-0000-4000-8000-000000000002',h,null)<>r then raise exception 'Reload retry duplicated address';end if;
 begin perform save_my_home('d9300000-0000-4000-8000-000000000001',h||'{"bedrooms":3}','{"firstName":"Synthetic","lastName":"Client","phone":"469-555-0100"}');raise exception 'Changed request accepted';exception when sqlstate 'PT409' then null;end;
 begin perform save_my_home('d9300000-0000-4000-8000-000000000003',h||'{"bathrooms":1.5}',null);raise exception 'Fractional rooms accepted';exception when sqlstate '22023' then null;end;
 begin perform save_my_home('d9300000-0000-4000-8000-000000000003',h||'{"customerId":"foreign"}',null);raise exception 'Caller identity accepted';exception when sqlstate '22023' then null;end;
 -- A first home can immediately reach the existing exact-price booking path.
 b:=review_my_booking('d9400000-0000-4000-8000-000000000001',v_property,'standard','one_time',now()+interval '30 days',false,'[]','Synthetic setup booking');
 if (b->>'totalCents')::integer is distinct from 19900 then raise exception 'First-home price wrong: %',b;end if;
 perform confirm_my_booking('d9400000-0000-4000-8000-000000000001');
 if (select count(*) from jobs where property_id=v_property)<>1 then raise exception 'First-home booking unavailable';end if;
end $$;
reset role;
update properties set gate_code='preserved code', access_notes='preserved entry' where id=(select (result->>'id')::uuid from home_setup_results);
create temporary table home_setup_preserved as select c.id,to_jsonb(c) data from customers c where profile_id='d9100000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','d9100000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare h jsonb; r jsonb; begin
 select result into r from home_setup_results;h:=r->'home';
 perform save_my_home('d9300000-0000-4000-8000-000000000004',h||'{"street":"200 Synthetic Setup Way"}','{"firstName":"Changed","lastName":"Contact","phone":"469-555-0101"}');
 if (select gate_code from properties where id=(r->>'id')::uuid)<>'preserved code' then raise exception 'Existing instructions overwritten';end if;
end $$;
reset role;
do $$ begin
 if exists(select 1 from home_setup_preserved s join customers c on c.id=s.id where to_jsonb(c)<>s.data) then raise exception 'Existing contact rewritten';end if;
 if (select count(*) from customers where profile_id='d9100000-0000-4000-8000-000000000001')<>1 then raise exception 'Customer duplicated';end if;
end $$;
set local role authenticated;
do $$ declare h jsonb; begin
 select result->'home' into h from home_setup_results;
 perform set_config('request.jwt.claim.sub','d9100000-0000-4000-8000-000000000002',true);
 begin perform save_my_home(gen_random_uuid(),h,'{"firstName":"Test","lastName":"Client","phone":"469-555-0100"}');raise exception 'Unconfirmed identity accepted';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','d9100000-0000-4000-8000-000000000003',true);
 begin perform save_my_home(gen_random_uuid(),h,'{"firstName":"Test","lastName":"Client","phone":"469-555-0100"}');raise exception 'Imported customer claimed by email';exception when sqlstate 'PHC01' then null;end;
 perform set_config('request.jwt.claim.sub','',true);
 begin perform save_my_home(gen_random_uuid(),h,null);raise exception 'Unsigned caller accepted';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','d9100000-0000-4000-8000-000000000004',true);
 perform save_my_home('d9300000-0000-4000-8000-000000000001',h,'{"firstName":"Other","lastName":"Client","phone":"469-555-0100"}');
 if (select count(*) from properties)<>1 then raise exception 'Another Client home leaked';end if;
end $$;
reset role;
update profiles set role='cleaner' where id='d9100000-0000-4000-8000-000000000004';
set local role authenticated;
do $$ declare h jsonb;begin
 select result->'home' into h from home_setup_results;
 begin perform save_my_home(gen_random_uuid(),h,null);raise exception 'Cleaner saved Client home';exception when insufficient_privilege then null;end;
end $$;
reset role;
update profiles set role='admin' where id='d9100000-0000-4000-8000-000000000004';
set local role authenticated;
do $$ declare h jsonb;begin
 select result->'home' into h from home_setup_results;
 begin perform save_my_home(gen_random_uuid(),h,null);raise exception 'Management saved Client home through self-service';exception when insufficient_privilege then null;end;
 raise notice 'Client home setup: verified bootstrap, retry, first booking, isolation and preservation passed';
end $$;
rollback;
