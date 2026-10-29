-- Metadata-only disposable fixtures. No image bytes or provider uploads.
begin;
do $$
declare c uuid; h uuid; j uuid; k uuid; other_k uuid; fee_id uuid; id1 uuid; id2 uuid; room text; photo_kind text; path text;
begin
 insert into public.customers(first_name,last_name) values('SYNTHETIC','Photo receipt') returning id into c;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,utility_rooms) values(c,'SYNTHETIC ONLY','Dallas','75201',1,1,0) returning id into h;
 insert into public.cleaners(full_name,type,status) values('SYNTHETIC assigned','contractor_1099','active') returning id into k;
 insert into public.cleaners(full_name,type,status) values('SYNTHETIC unassigned','contractor_1099','active') returning id into other_k;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at) values(c,h,'complete','standard','one_time',19900,120,now()) returning id into j;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(j,k,true,6965);
 path:='jobs/'||j||'/kitchen_1-before.jpg';
 insert into storage.objects(bucket_id,name) values('job-photos',path);
 begin perform public.record_job_photo(j,other_k,path,'before','kitchen_1');raise exception 'Unassigned photo accepted';exception when insufficient_privilege then null;end;
 begin perform public.record_job_photo(j,k,'jobs/other/kitchen_1-before.jpg','before','kitchen_1');raise exception 'Foreign path accepted';exception when invalid_parameter_value then null;end;
 begin perform public.record_job_photo(j,k,'jobs/'||j||'/invented-before.jpg','before','invented');raise exception 'Unknown room accepted';exception when invalid_parameter_value then null;end;
 begin perform public.record_job_photo(j,k,'jobs/'||j||'/kitchen_1-after.jpg','after','kitchen_1');raise exception 'Missing bytes accepted';exception when sqlstate 'PPH01' then null;end;
 update storage.objects set archived_at=now() where bucket_id='job-photos' and name=path;
 begin perform public.record_job_photo(j,k,path,'before','kitchen_1');raise exception 'Archived object accepted';exception when sqlstate 'PPH01' then null;end;
 update storage.objects set archived_at=null,is_delete_marker=true where bucket_id='job-photos' and name=path;
 begin perform public.record_job_photo(j,k,path,'before','kitchen_1');raise exception 'Delete marker accepted';exception when sqlstate 'PPH01' then null;end;
 update storage.objects set is_delete_marker=false where bucket_id='job-photos' and name=path;
 id1:=public.record_job_photo(j,k,path,'before','kitchen_1');
 id2:=public.record_job_photo(j,k,path,'before','kitchen_1');
 if id1 is null or id1 is distinct from id2 then raise exception 'Photo retry changed its receipt';end if;
 path:='jobs/'||j||'/kitchen_1-issue.jpg';
 insert into storage.objects(bucket_id,name) values('job-photos',path);
 id1:=public.record_job_photo(j,k,path,'issue','kitchen_1');id2:=public.record_job_photo(j,k,path,'issue','kitchen_1');
 if id1 is distinct from id2 or (select count(*) from public.job_photos where job_id=j and kind='issue')<>1 then raise exception 'Issue retry duplicated its receipt';end if;
 -- Arbitrary complete room pairs cannot stand in for real required slots.
 foreach room in array array['wrong_1','wrong_2','wrong_3','wrong_4'] loop
  insert into public.job_photos(job_id,cleaner_id,storage_path,kind,room_key) values(j,k,'SYNTHETIC/no-object/'||room,'before',room),(j,k,'SYNTHETIC/no-object/'||room||'-after','after',room);
 end loop;
 if public.settle_job_invoice(j) is not null then raise exception 'Arbitrary pairs created a bill';end if;
 -- Exact metadata still cannot stand in for missing objects.
 foreach room in array array['kitchen_1','bathroom_1','living_room_1','bedroom_1'] loop
  foreach photo_kind in array array['before','after'] loop
   path:='jobs/'||j||'/'||room||'-'||photo_kind||'.jpg';
   insert into public.job_photos(job_id,cleaner_id,storage_path,kind,room_key) values(j,k,path,photo_kind,room) on conflict(job_id,room_key,kind) where room_key is not null and kind in ('before','after') do nothing;
  end loop;
 end loop;
 if public.settle_job_invoice(j) is not null then raise exception 'Metadata without objects created a bill';end if;
 foreach room in array array['kitchen_1','bathroom_1','living_room_1','bedroom_1'] loop
  foreach photo_kind in array array['before','after'] loop
   insert into storage.objects(bucket_id,name) values('job-photos','jobs/'||j||'/'||room||'-'||photo_kind||'.jpg') on conflict do nothing;
  end loop;
 end loop;
 update storage.objects set archived_at=now() where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 if public.settle_job_invoice(j) is not null then raise exception 'Archived evidence created a bill';end if;
 update storage.objects set archived_at=null,is_delete_marker=true where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 if public.settle_job_invoice(j) is not null then raise exception 'Deleted evidence created a bill';end if;
 update storage.objects set is_delete_marker=false where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 insert into public.invoices(customer_id,kind,status,subtotal_cents,total_cents) values(c,'reschedule_fee','sent',6000,6000) returning id into fee_id;
 id1:=public.settle_job_invoice(j);id2:=public.settle_job_invoice(j);
 if id1 is null or id1 is distinct from id2 or (select count(*) from public.invoices where job_id=j and kind='service')<>1 then raise exception 'Verified gate failed idempotency';end if;
 if not exists(select 1 from public.invoices where id=id1 and status='draft' and subtotal_cents=19900 and total_cents=19900) then raise exception 'Gate changed the agreed price or issued a bill';end if;
 update public.jobs set invoiced_at=null where id=j;
 id2:=public.settle_job_invoice(j);
 if id2 is distinct from id1 or (select invoiced_at from public.jobs where id=j) is null then raise exception 'Existing service receipt was not reused';end if;
 update public.invoices set status='void',voided_at=now() where id=id1;update public.jobs set invoiced_at=null where id=j;
 if public.settle_job_invoice(j) is not null or (select count(*) from public.invoices where job_id=j and kind='service')<>1 then raise exception 'Voided service invoice replaced';end if;
 if not exists(select 1 from public.invoices where id=fee_id and kind='reschedule_fee' and total_cents=6000 and status='sent') then raise exception 'Service gate changed the fee';end if;
 if has_table_privilege('authenticated','public.job_photos','INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon','public.job_photos','SELECT') or not has_table_privilege('authenticated','public.job_photos','SELECT') then raise exception 'Direct photo writes or anonymous reads remain';end if;
 if has_function_privilege('authenticated','public.record_job_photo(uuid,uuid,text,text,text)','execute') or has_function_privilege('anon','public.settle_job_invoice(uuid)','execute') or has_function_privilege('service_role','public.record_job_photo(uuid,uuid,text,text,text)','execute') or not has_function_privilege('service_role','public.record_job_photo_capture(uuid,uuid,text,text,text,uuid,text,uuid[],uuid,text,bigint)','execute') then raise exception 'Photo execution grants changed';end if;
 raise notice 'Photo receipts passed: assignment, canonical slot, actual object, no false bill, idempotent receipt and draft price.';
end $$;
rollback;
