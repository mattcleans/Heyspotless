-- Metadata-only database regression; actual stream/hash checks live in server tests.
begin;
-- Disposable verifier metadata only; never run this fixture against a hosted project.
alter table storage.objects add column if not exists version text default gen_random_uuid()::text;
alter table storage.objects add column if not exists metadata jsonb default '{"size":3}'::jsonb;
do $$
declare a uuid:=gen_random_uuid();u uuid:=gen_random_uuid();c uuid;h uuid;j uuid;k uuid;i uuid;
 v1 uuid:=gen_random_uuid();v2 uuid:=gen_random_uuid();v3 uuid:=gen_random_uuid();v uuid;
 o1 uuid;o2 uuid;o uuid;path text;r jsonb;r1 jsonb;r2 jsonb;room text;kind text;due date:=(clock_timestamp() at time zone 'America/Chicago')::date+7;
begin
 insert into auth.users(id,email) values(a,'SYNTHETIC-capture-'||a||'@example.test'),(u,'SYNTHETIC-capture-'||u||'@example.test');
 update public.profiles set role='admin' where id=a;
 insert into public.customers(profile_id,first_name,last_name) values(u,'SYNTHETIC','Capture versions') returning id into c;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms) values(c,'SYNTHETIC ONLY','Dallas','75201',1,1,0,1,0,0) returning id into h;
 insert into public.cleaners(full_name,type,status,profile_published) values('SYNTHETIC capture','contractor_1099','active',false) returning id into k;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes) values(c,h,'in_progress','standard','one_time',19900,120) returning id into j;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(j,k,true,6965);
 path:='jobs/'||j||'/kitchen_1-before/'||v1||'.jpg';
 insert into storage.objects(bucket_id,name,version,metadata) values('job-photos',path,'object-v1','{"size":3}') returning id into o1;
 r:=public.job_photo_upload_candidate(j,k,path,'kitchen_1','before',v1);
 if r->>'objectId'<>o1::text or r->>'objectVersion'<>'object-v1' or (r->>'byteSize')::integer<>3 then raise exception 'Candidate lost object identity';end if;
 r1:=public.record_job_photo_capture(j,k,path,'kitchen_1','before',v1,repeat('a',64),'{}',o1,'object-v1',3);
 path:='jobs/'||j||'/kitchen_1-before/'||v2||'.jpg';
 insert into storage.objects(bucket_id,name,version,metadata) values('job-photos',path,'object-v2','{"size":3}') returning id into o2;
 r2:=public.record_job_photo_capture(j,k,path,'kitchen_1','before',v2,repeat('b',64),array[v1],o2,'object-v2',3);
 if public.record_job_photo_capture(j,k,r1->>'storagePath','kitchen_1','before',v1,repeat('a',64),'{}',o1,'object-v1',3) is distinct from r1 then raise exception 'Old receipt did not replay';end if;
 if (select ph.capture_revision from public.job_photos ph where ph.job_id=j and ph.room_key='kitchen_1' and ph.kind='before')<>v2 then raise exception 'Old accepted replay replaced current retake';end if;
 path:='jobs/'||j||'/kitchen_1-before/'||v3||'.jpg';
 insert into storage.objects(bucket_id,name,version,metadata) values('job-photos',path,'object-v3','{"size":3}') returning id into o;
 begin perform public.record_job_photo_capture(j,k,path,'kitchen_1','before',v3,repeat('c',64),'{}',o,'object-v3',3);raise exception 'Unknown branch replaced current capture';exception when sqlstate 'PPH01' then null;end;
 begin perform public.record_job_photo_capture(j,k,r1->>'storagePath','kitchen_1','before',v1,repeat('c',64),'{}',o1,'object-v1',3);raise exception 'Capture identity accepted different bytes';exception when sqlstate 'PPH01' then null;end;
 update storage.objects set version='overwritten' where id=o2;
 if jsonb_array_length(public.verified_job_photos(j))<>0 then raise exception 'Changed object counted as evidence';end if;
 begin perform public.record_job_photo_capture(j,k,r2->>'storagePath','kitchen_1','before',v2,repeat('b',64),array[v1],o2,'object-v2',3);raise exception 'Object changed between hashing and recording';exception when sqlstate 'PPH01' then null;end;
 update storage.objects set version='object-v2' where id=o2;
 foreach room in array array['kitchen_1','bathroom_1','bedroom_1'] loop
  foreach kind in array array['before','after'] loop
   if room='kitchen_1' and kind='before' then continue;end if;
   v:=gen_random_uuid();path:='jobs/'||j||'/'||room||'-'||kind||'/'||v||'.jpg';
   insert into storage.objects(bucket_id,name,version,metadata) values('job-photos',path,v::text,'{"size":3}') returning id into o;
   perform public.record_job_photo_capture(j,k,path,room,kind,v,repeat('d',64),'{}',o,v::text,3);
  end loop;
 end loop;
 update public.jobs set status='complete',completed_at=now() where id=j;
 i:=public.prepare_job_service_draft(j,19900);
 if i is null then raise exception 'Verified versioned evidence did not prepare a draft';end if;
 update storage.objects set version='changed-after-draft' where id=o2;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,due);raise exception 'Changed object issued an invoice';exception when sqlstate 'PIS01' then null;end;
 update storage.objects set version='object-v2' where id=o2;
 r:=public.issue_reviewed_service_invoice(j,i,a,19900,due);
 if r->>'issued'<>'true' or jsonb_array_length(public.verified_job_photos(j))<>6 or (select count(*) from spotless_private.photo_capture_receipts where job_id=j)<>7 then raise exception 'Versioned issuance or append-only history lost';end if;
 if exists(select 1 from public.payment_operations op join public.invoices inv on inv.id=op.invoice_id where inv.job_id=j) or exists(select 1 from public.payments where customer_id=c) then raise exception 'Capture verification initiated collection';end if;
 if has_function_privilege('authenticated','public.record_job_photo_capture(uuid,uuid,text,text,text,uuid,text,uuid[],uuid,text,bigint)','execute') or has_function_privilege('anon','public.job_photo_upload_candidate(uuid,uuid,text,text,text,uuid)','execute') or has_function_privilege('service_role','public.record_job_photo(uuid,uuid,text,text,text)','execute') or has_table_privilege('authenticated','public.job_photos','INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','spotless_private.photo_capture_receipts','SELECT,INSERT,UPDATE,DELETE') then raise exception 'Capture trust boundary exposed';end if;
 raise notice 'Capture versions passed: exact object/version, current retake preserved, old replay, conflicting branch refusal, unchanged-byte identity, version-aware read/draft/issuance, private receipts and no collection.';
end $$;
rollback;
