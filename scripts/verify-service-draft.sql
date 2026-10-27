-- Disposable metadata-only evidence. No images, issuance or provider payments.
begin;
do $$
declare c uuid; h uuid; j uuid; k uuid; id1 uuid; id2 uuid; room text; photo_kind text; path text;
begin
 insert into public.customers(first_name,last_name) values('SYNTHETIC','Service draft') returning id into c;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,utility_rooms) values(c,'SYNTHETIC ONLY','Dallas','75201',1,1,0) returning id into h;
 insert into public.cleaners(full_name,type,status) values('SYNTHETIC draft verifier','contractor_1099','active') returning id into k;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes) values(c,h,'assigned','standard','one_time',19900,120) returning id into j;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(j,k,true,6965);
 if public.prepare_job_service_draft(j,19900) is not null then raise exception 'Unfinished work received a draft';end if;
 update public.jobs set status='complete',completed_at=now() where id=j;
 begin perform public.prepare_job_service_draft(j,20000);raise exception 'Stale price accepted';exception when sqlstate 'PFD01' then null;end;
 if public.prepare_job_service_draft(j,19900) is not null then raise exception 'Missing evidence received a draft';end if;
 foreach room in array array['kitchen_1','bathroom_1','living_room_1','bedroom_1'] loop
  foreach photo_kind in array array['before','after'] loop
   path:='jobs/'||j||'/'||room||'-'||photo_kind||'.jpg';
   insert into storage.objects(bucket_id,name) values('job-photos',path);
   insert into public.job_photos(job_id,cleaner_id,storage_path,room_key,kind) values(j,k,path,room,photo_kind);
  end loop;
 end loop;
 id1:=public.prepare_job_service_draft(j,19900);id2:=public.prepare_job_service_draft(j,19900);
 if id1 is null or id1 is distinct from id2 or (select count(*) from public.invoices where job_id=j)<>1 then raise exception 'Draft recovery duplicated or lost the service receipt';end if;
 if not exists(select 1 from public.invoices where id=id1 and kind='service' and status='draft' and total_cents=19900 and issued_at is null and amount_paid_cents=0) then raise exception 'Draft recovery changed the price, issued a bill or recorded a payment';end if;
 update public.jobs set invoiced_at=null where id=j;
 id2:=public.prepare_job_service_draft(j,19900);
 if id2 is distinct from id1 or (select invoiced_at from public.jobs where id=j) is null then raise exception 'Existing draft marker was not restored';end if;
 update public.invoices set status='void',voided_at=now() where id=id1;update public.jobs set invoiced_at=null where id=j;
 if public.prepare_job_service_draft(j,19900) is not null then raise exception 'Voided invoice was replaced';end if;
 if has_function_privilege('anon','public.prepare_job_service_draft(uuid,integer)','execute') or has_function_privilege('authenticated','public.prepare_job_service_draft(uuid,integer)','execute') or not has_function_privilege('service_role','public.prepare_job_service_draft(uuid,integer)','execute') then raise exception 'Draft routine is not service-only';end if;
 raise notice 'Management draft recovery passed: completed work, reviewed price, verified evidence, one receipt, marker recovery, no void replacement, draft only and service execution.';
end $$;
rollback;
