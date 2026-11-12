-- Disposable metadata only. Every issuance/fixture rolls back; no provider.
begin;
do $$
declare a uuid:=gen_random_uuid();u uuid:=gen_random_uuid();c uuid;h uuid;j uuid;k uuid;i uuid;fee uuid;extra uuid;op uuid;
 d date:=(clock_timestamp() at time zone 'America/Chicago')::date+7;r jsonb;r2 jsonb;room text;kind text;path text;
begin
 insert into auth.users(id,email) values(a,'issue-'||a||'@example.test'),(u,'issue-'||u||'@example.test');
 update public.profiles set role='admin' where id=a;
 insert into public.customers(profile_id,first_name,last_name) values(u,'SYNTHETIC','Invoice issuance') returning id into c;
 insert into public.properties(customer_id,street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms)
 values(c,'SYNTHETIC ONLY','Dallas','75201',1,1,0,1,0,0) returning id into h;
 insert into public.cleaners(full_name,type,status,profile_published) values('SYNTHETIC issuance','contractor_1099','active',false) returning id into k;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at)
 values(c,h,'complete','standard','one_time',19900,120,now()) returning id into j;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(j,k,true,6965);
 insert into public.invoices(job_id,customer_id,kind,status,subtotal_cents,total_cents) values(j,c,'service','draft',19900,19900) returning id into i;
 begin perform public.issue_reviewed_service_invoice(j,i,u,19900,d);raise exception 'Client issued a bill';exception when insufficient_privilege then null;end;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Missing photos issued a bill';exception when sqlstate 'PIS01' then null;end;
 foreach room in array array['kitchen_1','bathroom_1','bedroom_1'] loop
  foreach kind in array array['before','after'] loop
   path:='jobs/'||j||'/'||room||'-'||kind||'.jpg';
   insert into storage.objects(bucket_id,name) values('job-photos',path);
   insert into public.job_photos(job_id,cleaner_id,storage_path,room_key,kind) values(j,k,path,room,kind);
  end loop;
 end loop;
 delete from storage.objects where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Photo metadata without an object issued a bill';exception when sqlstate 'PIS01' then null;end;
 insert into storage.objects(bucket_id,name) values('job-photos','jobs/'||j||'/bedroom_1-after.jpg');
 insert into public.invoices(job_id,customer_id,kind,status,subtotal_cents,total_cents) values(j,c,'service','draft',19900,19900) returning id into extra;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Ambiguous service invoice issued';exception when sqlstate 'PIS01' then null;end;
 delete from public.invoices where id=extra;
 insert into public.payment_operations(invoice_id,channel,idempotency_key,amount_cents,expires_at,state) values(i,'checkout','SYNTHETIC-issue-'||i,19900,now()+interval '1 hour','open') returning id into op;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Open collection claim issued a draft';exception when sqlstate 'PIS01' then null;end;
 update public.payment_operations set state='abandoned',resolved_at=now() where id=op;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Unresolved abandoned claim issued a draft';exception when sqlstate 'PIS01' then null;end;
 delete from public.payment_operations where id=op;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19901,d);raise exception 'Stale total issued a bill';exception when sqlstate 'PIS01' then null;end;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,(clock_timestamp() at time zone 'America/Chicago')::date-1);raise exception 'Past due date issued a bill';exception when sqlstate 'PIS01' then null;end;
 update public.jobs set price_cents=20900 where id=j;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Changed visit price issued a bill';exception when sqlstate 'PIS01' then null;end;
 update public.jobs set price_cents=19900,status='assigned',completed_at=null where id=j;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Unfinished visit issued a bill';exception when sqlstate 'PIS01' then null;end;
 update public.jobs set status='complete',completed_at=now() where id=j;
 update storage.objects set archived_at=now() where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Archived object issued a bill';exception when sqlstate 'PIS01' then null;end;
 update storage.objects set archived_at=null,is_delete_marker=true where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Deleted object issued a bill';exception when sqlstate 'PIS01' then null;end;
 update storage.objects set is_delete_marker=false where bucket_id='job-photos' and name='jobs/'||j||'/bedroom_1-after.jpg';
 delete from public.job_room_scopes where job_id=j;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Unknown scope issued a bill';exception when sqlstate 'PIS01' then null;end;
 perform spotless_private.capture_job_room_scope(j,true);
 insert into public.invoices(customer_id,kind,status,subtotal_cents,total_cents) values(c,'reschedule_fee','sent',6000,6000) returning id into fee;
 begin perform public.issue_reviewed_service_invoice(j,fee,a,6000,d);raise exception 'Fee substituted for service invoice';exception when sqlstate 'PIS01' then null;end;
 update public.invoices set credit_cents=100 where id=i;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Adjusted draft issued without review';exception when sqlstate 'PIS01' then null;end;
 update public.invoices set credit_cents=0 where id=i;
 if (select status from public.invoices where id=i)<>'draft' or exists(select 1 from spotless_private.service_invoice_issuances where invoice_id=i) then raise exception 'Rejected issuance changed state';end if;
 r:=public.issue_reviewed_service_invoice(j,i,a,19900,d);
 r2:=public.issue_reviewed_service_invoice(j,i,a,19900,d);
 if r is distinct from r2 or r->>'issued'<>'true' or r->>'invoiceId'<>i::text or r->>'visitId'<>j::text or (r->>'totalCents')::integer<>19900 or (r->>'dueOn')::date<>d then raise exception 'Issuance lost its exact durable receipt';end if;
 if (select count(*) from spotless_private.service_invoice_issuances where invoice_id=i and issued_by=a)<>1
  or not exists(select 1 from public.invoices where id=i and status='sent' and issued_at=(r->>'issuedAt')::timestamptz and due_on=d and amount_paid_cents=0 and next_attempt_at is null)
  or (select invoiced_at from public.jobs where id=j) is null then raise exception 'Issued invoice/actor/date/marker did not persist';end if;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d+1);raise exception 'Retry rewrote due date';exception when sqlstate 'PIS01' then null;end;
 -- Payment after issuance does not erase the original historical receipt.
 update public.invoices set status='paid',amount_paid_cents=19900 where id=i;
 if public.issue_reviewed_service_invoice(j,i,a,19900,d) is distinct from r then raise exception 'Settled bill lost its issuance receipt';end if;
 update public.invoices set status='void',voided_at=now() where id=i;
 begin perform public.issue_reviewed_service_invoice(j,i,a,19900,d);raise exception 'Voided invoice reissued';exception when sqlstate 'PIS01' then null;end;
 if exists(select 1 from public.payments where customer_id=c) or exists(select 1 from public.payment_operations where invoice_id=i) then raise exception 'Issuance initiated collection';end if;
 if has_function_privilege('anon','public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date)','execute') or has_function_privilege('authenticated','public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date)','execute') or not has_function_privilege('service_role','public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date)','execute') then raise exception 'Issuance is not service-only';end if;
 if has_table_privilege('authenticated','spotless_private.service_invoice_issuances','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('service_role','spotless_private.service_invoice_issuances','INSERT,UPDATE,DELETE') then raise exception 'Issuance receipt exposed for app rewriting';end if;
 raise notice 'Invoice issuance passed: office actor, locked review, exact live evidence, safe rejection, durable date/amount, replay, paid history, no void reissue and no collection.';
end $$;
rollback;
