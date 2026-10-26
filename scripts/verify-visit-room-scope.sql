-- Rollback-only synthetic accounts and metadata. No image or provider calls.
begin;
do $$
declare u uuid[]:='{}'; c uuid; other_c uuid; h uuid; other_h uuid; k uuid; other_k uuid;
 j uuid; fresh uuid; board uuid; plan uuid; plan_first uuid; plan_next uuid; legacy uuid;
 review uuid; old_price integer; expected_price integer; expected_minutes integer; changed_price integer; cadence jsonb; receipt uuid; n integer; room text; photo_kind text; path text; start_at timestamptz;
begin
 for n in 1..5 loop
  u:=array_append(u,gen_random_uuid());
  insert into auth.users(id,email) values(u[n],'scope-'||u[n]::text||'@example.test');
  update public.profiles set role=case when n=3 then 'admin'::public.user_role when n>=4 then 'cleaner'::public.user_role else 'customer'::public.user_role end where id=u[n];
 end loop;
 insert into public.customers(profile_id,first_name,last_name) values(u[1],'SYNTHETIC','Saved scope') returning id into c;
 insert into public.customers(profile_id,first_name,last_name) values(u[2],'SYNTHETIC','Other scope') returning id into other_c;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms)
 values(c,'SYNTHETIC ONLY','Dallas','75201',1,1,1,1,0,0) returning id into h;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms)
 values(other_c,'SYNTHETIC ONLY','Dallas','75201',1,1,0,1,0,0) returning id into other_h;
 insert into public.cleaners(profile_id,full_name,type,status,profile_published) values(u[4],'SYNTHETIC scope assigned','contractor_1099','active',false) returning id into k;
 insert into public.cleaners(profile_id,full_name,type,status,profile_published) values(u[5],'SYNTHETIC scope other','contractor_1099','active',false) returning id into other_k;
 perform set_config('request.jwt.claim.sub',u[1]::text,true);
 start_at:=date_trunc('minute',clock_timestamp()+interval '14 days');review:=gen_random_uuid();
 perform public.review_my_booking(review,h,'standard','one_time',start_at,false,'[]','SYNTHETIC scope verification');
 perform public.confirm_my_booking(review);
 select job_id into j from spotless_private.client_booking_reviews where id=review;
 select price_cents into old_price from public.jobs where id=j;
 if not exists(select 1 from public.job_room_scopes where job_id=j and source='client_booking' and bedrooms=1 and bathrooms=1 and half_baths=1 and kitchens=1 and living_rooms=0 and utility_rooms=0) then raise exception 'Confirmed booking did not capture the exact six room counts';end if;
 update public.properties set bedrooms=4,bathrooms=3,half_baths=0,kitchens=2,living_rooms=3,utility_rooms=2 where id=h;
 if not exists(select 1 from public.job_room_scopes where job_id=j and bedrooms=1 and half_baths=1 and kitchens=1 and living_rooms=0) then raise exception 'Later home edit changed the accepted visit';end if;
 review:=gen_random_uuid();
 perform public.review_my_booking(review,h,'standard','one_time',start_at+interval '1 day',false,'[]','SYNTHETIC new booking');
 perform public.confirm_my_booking(review);
 select job_id into fresh from spotless_private.client_booking_reviews where id=review;
 if not exists(select 1 from public.job_room_scopes where job_id=fresh and source='client_booking' and bedrooms=4 and kitchens=2 and living_rooms=3 and half_baths=0) then raise exception 'New booking did not use the newly reviewed home';end if;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(j,k,true,floor(old_price*.35)::integer);
 update public.jobs set status='complete',completed_at=now() where id=j;
 foreach room in array array['kitchen_1','bathroom_1','half_bath_1','bedroom_1'] loop
  foreach photo_kind in array array['before','after'] loop
   path:='jobs/'||j||'/'||room||'-'||photo_kind||'.jpg';
   insert into storage.objects(bucket_id,name) values('job-photos',path);
   perform public.record_job_photo(j,k,path,photo_kind,room);
  end loop;
 end loop;
 if not exists(select 1 from public.invoices where job_id=j and kind='service' and status='draft' and total_cents=old_price) then raise exception 'Invoice gate followed changed home counts instead of agreed visit counts';end if;
 begin perform public.record_job_photo(j,k,'jobs/'||j||'/bedroom_4-before.jpg','before','bedroom_4');raise exception 'New home room was silently added to old visit';exception when invalid_parameter_value then null;end;
 -- Simulate a rollout backfill: existing agreement must win over today's home.
 delete from public.job_room_scopes where job_id=j;
 perform spotless_private.capture_job_room_scope(j,true);
 if not exists(select 1 from public.job_room_scopes where job_id=j and source='client_booking' and bedrooms=1 and half_baths=1) then raise exception 'Backfill lost the saved agreement';end if;
 -- An unknown scope must never become a zero-photo requirement.
 delete from public.invoices where job_id=j;update public.jobs set invoiced_at=null where id=j;
 delete from public.job_room_scopes where job_id=j;
 if public.settle_job_invoice(j) is not null then raise exception 'Missing scope created an invoice';end if;
 begin perform public.record_job_photo(j,k,'jobs/'||j||'/kitchen_1-before.jpg','before','kitchen_1');raise exception 'Missing scope acknowledged a photo';exception when invalid_parameter_value then null;end;
 perform spotless_private.capture_job_room_scope(j,true);
 receipt:=public.prepare_job_service_draft(j,old_price);
 if receipt is null then raise exception 'Restored agreement could not recover its service draft';end if;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,dispatch_channel)
 values(c,h,'dispatching','standard','one_time',19900,120,'open_board') returning id into board;
 -- A manual/legacy recurring plan keeps its first saved baseline, including
 -- after the home changes. A new independent booking remains free to differ.
 insert into public.recurring_plans(customer_id,property_id,freq,service,agreed_price_cents,estimated_minutes,anchor_date,start_time)
 values(other_c,other_h,'biweekly','standard',10000,60,(clock_timestamp() at time zone 'America/Chicago')::date+14,'09:00') returning id into plan;
 insert into public.jobs(customer_id,property_id,recurring_plan_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at)
 values(other_c,other_h,plan,'complete','standard','biweekly',10000,60,now()) returning id into plan_first;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(plan_first,other_k,true,3500);
 update public.properties set kitchens=2,living_rooms=1 where id=other_h;
 insert into public.jobs(customer_id,property_id,recurring_plan_id,status,service,freq,price_cents,estimated_clean_minutes)
 values(other_c,other_h,plan,'scheduled','standard','biweekly',10000,60) returning id into plan_next;
 if not exists(select 1 from public.job_room_scopes a join public.job_room_scopes b on a.job_id=plan_first and b.job_id=plan_next where a.kitchens=1 and b.kitchens=1 and b.living_rooms=0 and a.captured_at=b.captured_at) then raise exception 'Recurring occurrence silently changed its saved scope';end if;
 update public.recurring_plans set quote_extras='[{"totalCents":2500,"cleanMinutes":30}]'::jsonb where id=plan;
 select total_cents+2500,clean_minutes+30 into expected_price,expected_minutes from public.quote_price('standard','weekly',1,1,0,1,0,0);
 select total_cents into changed_price from public.quote_price('standard','weekly',1,1,0,2,1,0);
 cadence:=public.preview_recurring_edit(plan,(clock_timestamp() at time zone 'America/Chicago')::date+15,'weekly','09:00',null,null,(clock_timestamp() at time zone 'America/Chicago')::date+1);
 if expected_price=changed_price+2500 or (cadence->>'price_cents')::integer<>expected_price or (cadence->>'estimated_minutes')::integer<>expected_minutes or (cadence->'room_counts'->>'kitchens')::integer<>1 then raise exception 'Cadence repricing lost saved rooms or agreed extras';end if;
 if not exists(select 1 from public.recurring_plan_room_scopes where plan_id=plan and kitchens=1 and living_rooms=0) then raise exception 'Plan scope drifted';end if;

 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes)
 values(other_c,other_h,'scheduled','standard','one_time',10000,60) returning id into legacy;
 delete from public.job_room_scopes where job_id=legacy;perform spotless_private.capture_job_room_scope(legacy,true);
 if not exists(select 1 from public.job_room_scopes where job_id=legacy and source='legacy_home' and kitchens=2) then raise exception 'Legacy baseline was mislabeled as an agreement';end if;
 if has_table_privilege('authenticated','public.recurring_plan_room_scopes','INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('service_role','public.recurring_plan_room_scopes','INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon','public.recurring_plan_room_scopes','SELECT') or has_table_privilege('authenticated','public.job_room_scopes','INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('service_role','public.job_room_scopes','INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon','public.job_room_scopes','SELECT') then raise exception 'Saved scopes allow direct app writes or anonymous reads';end if;
 perform set_config('scope_test.client',u[1]::text,true);perform set_config('scope_test.other_client',u[2]::text,true);
 perform set_config('scope_test.admin',u[3]::text,true);perform set_config('scope_test.cleaner',u[4]::text,true);perform set_config('scope_test.other_cleaner',u[5]::text,true);
 perform set_config('scope_test.job',j::text,true);perform set_config('scope_test.board',board::text,true);
 perform set_config('scope_test.plan',plan::text,true);
 perform set_config('scope_test.ids',array_to_string(array[j,fresh,board,plan_first,plan_next],','),true);
end $$;
set local role authenticated;
do $$ begin
 perform set_config('request.jwt.claim.sub',current_setting('scope_test.client'),true);
 if exists(select 1 from public.recurring_plan_room_scopes where plan_id=current_setting('scope_test.plan')::uuid) then raise exception 'Other Client plan scope leaked';end if;
 if (select count(*) from public.job_room_scopes where job_id=any(string_to_array(current_setting('scope_test.ids'),',')::uuid[]))<>3 then raise exception 'Client cannot read exactly own saved scopes';end if;
 perform set_config('request.jwt.claim.sub',current_setting('scope_test.other_client'),true);
 if not exists(select 1 from public.recurring_plan_room_scopes where plan_id=current_setting('scope_test.plan')::uuid) then raise exception 'Own plan scope unavailable';end if;
 if (select count(*) from public.job_room_scopes where job_id=any(string_to_array(current_setting('scope_test.ids'),',')::uuid[]))<>2 then raise exception 'Other Client saved scopes leaked';end if;
 perform set_config('request.jwt.claim.sub',current_setting('scope_test.cleaner'),true);
 if exists(select 1 from public.recurring_plan_room_scopes where plan_id=current_setting('scope_test.plan')::uuid) then raise exception 'Cleaner received Client plan scope';end if;
 if (select count(*) from public.job_room_scopes where job_id=any(string_to_array(current_setting('scope_test.ids'),',')::uuid[]))<>1 then raise exception 'Cleaner reads exceed assigned visits';end if;
 if exists(select 1 from public.job_room_scopes where job_id=current_setting('scope_test.board')::uuid) then raise exception 'Unassigned open-board scope leaked';end if;
 perform set_config('request.jwt.claim.sub',current_setting('scope_test.other_cleaner'),true);
 if (select count(*) from public.job_room_scopes where job_id=any(string_to_array(current_setting('scope_test.ids'),',')::uuid[]))<>1 then raise exception 'Other Cleaner saved scopes leaked';end if;
 perform set_config('request.jwt.claim.sub',current_setting('scope_test.admin'),true);
 if (select count(*) from public.job_room_scopes where job_id=any(string_to_array(current_setting('scope_test.ids'),',')::uuid[]))<>5 then raise exception 'Management cannot read saved scopes';end if;
 raise notice 'Saved visit scope passed: confirmed booking, changed home, new booking, exact photo invoice, original backfill, missing-scope refusal, recurring baseline, saved-scope cadence pricing, legacy provenance and role reads.';
end $$;
reset role;
rollback;
