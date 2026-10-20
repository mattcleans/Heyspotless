-- Disposable preview/CI fixtures. No provider calls; all rows roll back.
begin;
do $$
declare
 v_profile uuid:=pg_catalog.gen_random_uuid(); v_other uuid:=pg_catalog.gen_random_uuid();
 v_customer uuid; v_home uuid; v_cleaner uuid; v_job uuid; v_invoice uuid; v_second uuid;
 v_a uuid:=pg_catalog.gen_random_uuid(); v_b uuid:=pg_catalog.gen_random_uuid();
 v_result jsonb; v_saved jsonb; v_id uuid; v_count integer;
begin
 -- Use the normal auth trigger so profile ownership matches a real signup.
 insert into auth.users(id,email,raw_user_meta_data) values
  (v_profile,'feedback-'||v_profile::text||'@example.test','{"full_name":"SYNTHETIC Feedback Client"}'::jsonb),
  (v_other,'feedback-'||v_other::text||'@example.test','{"full_name":"SYNTHETIC Other Client"}'::jsonb);
 insert into public.customers(profile_id,first_name,last_name) values(v_profile,'SYNTHETIC','Feedback Client') returning id into v_customer;
 insert into public.properties(customer_id,street,city,zip) values(v_customer,'SYNTHETIC PREVIEW ONLY','Dallas','75201') returning id into v_home;
 insert into public.cleaners(full_name,type,status,rating,background_check_cleared)
  values('SYNTHETIC Feedback Cleaner','contractor_1099','active',4.8,true) returning id into v_cleaner;
 insert into public.jobs(customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,completed_at)
  values(v_customer,v_home,'complete','standard','one_time',17000,120,now()) returning id into v_job;
 insert into public.job_assignments(job_id,cleaner_id,is_lead,payout_cents) values(v_job,v_cleaner,true,5610);
 insert into public.invoices(customer_id,job_id,status,subtotal_cents,total_cents,due_on)
  values(v_customer,v_job,'sent',17000,17000,public.business_today()+7) returning id into v_invoice;

 v_result:=public.record_client_visit_feedback_once(v_a,v_profile,v_job,5,'SYNTHETIC public review',array['thorough'],'SYNTHETIC private note',2000);
 if (v_result->>'recorded') is distinct from 'true' or (v_result#>>'{tip,tipCents}')::integer<>2000 then raise exception 'Feedback was not recorded'; end if;
 if not exists(select 1 from public.invoices where id=v_invoice and tip_cents=2000 and total_cents=19000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=2000 and tip_fee_cents=58 and tip_net_cents=1942) then raise exception 'Invoice/payout tip did not reconcile'; end if;
 v_saved:=v_result;
 if public.record_client_visit_feedback_once(v_a,v_profile,v_job,5,'SYNTHETIC public review',array['thorough'],'SYNTHETIC private note',2000) is distinct from v_saved then raise exception 'Retry changed the receipt'; end if;

 perform public.record_client_visit_feedback_once(v_b,v_profile,v_job,4,null,'{}','New private note',4000);
 if not exists(select 1 from public.ratings where job_id=v_job and comment='SYNTHETIC public review' and private_note='New private note') then raise exception 'Rating edit erased earlier public review'; end if;
 -- The first response was lost; its retry must not restore an older tip.
 if public.record_client_visit_feedback_once(v_a,v_profile,v_job,5,'SYNTHETIC public review',array['thorough'],'SYNTHETIC private note',2000) is distinct from v_saved then raise exception 'Lost-response receipt changed'; end if;
 if not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000 and total_cents=21000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=4000) then raise exception 'Old retry overwrote newer tip'; end if;
 if (select count(*) from public.ratings where job_id=v_job)<>1 or (select count(*) from public.payouts where job_id=v_job)<>1 then raise exception 'Retry duplicated a rating or payout'; end if;
 -- Settled money records cannot be rewritten by either the Client RPC or a
 -- direct service upsert. Invoice changes roll back while the rating survives.
 update public.payouts set paid_at=now() where job_id=v_job;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,3,null,'{}','Settled payout keeps this note',3000);
 if (v_result->>'tipError') is distinct from 'tip_settled_review'
  or not exists(select 1 from public.ratings where job_id=v_job and score=3 and private_note='Settled payout keeps this note')
  or not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000 and total_cents=21000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=4000 and paid_at is not null) then raise exception 'Settled payout was changed or rating was lost'; end if;
 begin
  perform public.record_tip_payout(v_job,3000);
  raise exception 'Direct upsert rewrote settled payout';
 exception when object_not_in_prerequisite_state then null; end;
 update public.payouts set paid_at=null,stripe_transfer_id='SYNTHETIC-feedback-transfer-'||v_job::text where job_id=v_job;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,4,null,'{}',null,3000);
 if (v_result->>'tipError') is distinct from 'tip_settled_review'
  or not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=4000 and stripe_transfer_id is not null) then raise exception 'Transferred payout was rewritten'; end if;
 update public.payouts set stripe_transfer_id=null where job_id=v_job;
 begin
  perform public.record_client_visit_feedback_once(v_a,v_profile,v_job,5,null,'{}',null,3000);
  raise exception 'Same receipt accepted another amount';
 exception when insufficient_privilege then null; end;
 if (public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_other,v_job,1,null,'{}',null,1000)->>'recorded')::boolean then raise exception 'Another Client changed feedback'; end if;

 perform public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,3,null,'{}','Rating only',0);
 if not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000) then raise exception 'Rating-only submission removed a tip'; end if;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,5,null,'{}','Ceiling failure keeps this note',17001);
 if (v_result->>'tipError') is distinct from 'tip_above_price' or not exists(select 1 from public.ratings where job_id=v_job and score=5 and private_note='Ceiling failure keeps this note') then raise exception 'Tip failure lost the rating'; end if;
 if not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=4000) then raise exception 'Rejected tip left money writes'; end if;

 insert into public.payment_operations(invoice_id,channel,idempotency_key,amount_cents,expires_at)
  values(v_invoice,'checkout','SYNTHETIC-feedback-'||v_job::text,21000,now()+interval '15 minutes') returning id into v_id;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,4,null,'{}','Payment pending',3000);
 if (v_result->>'tipError') is distinct from 'tip_payment_in_progress' then raise exception 'In-flight payment amount changed'; end if;
 if not exists(select 1 from public.invoices where id=v_invoice and tip_cents=4000)
  or not exists(select 1 from public.payouts where job_id=v_job and tip_cents=4000) then raise exception 'Pending collection changed tip records'; end if;
 update public.payment_operations set state='failed',resolved_at=now() where id=v_id;

 -- An already paid service invoice gains a visible tip balance and status.
 update public.invoices set amount_paid_cents=17000,status='paid',tip_cents=0,total_cents=17000 where id=v_invoice;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,5,null,'{}',null,2000);
 if not exists(select 1 from public.invoices where id=v_invoice and status='sent' and balance_cents=2000) then raise exception 'New tip balance stayed marked paid'; end if;
 insert into public.invoices(customer_id,job_id,status,subtotal_cents,total_cents)
  values(v_customer,v_job,'sent',17000,17000) returning id into v_second;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,4,null,'{}',null,1000);
 if (v_result->>'tipError') is distinct from 'tip_invoice_review' then raise exception 'Ambiguous bill was tipped'; end if;
 delete from public.invoices where id=v_second;
 update public.invoices set status='void',voided_at=now() where id=v_invoice;
 v_result:=public.record_client_visit_feedback_once(pg_catalog.gen_random_uuid(),v_profile,v_job,4,null,'{}',null,1000);
 if (v_result->>'tipError') is distinct from 'tip_no_invoice' then raise exception 'Voided bill was tipped'; end if;

 select count(*) into v_count from spotless_private.client_feedback_receipts where job_id=v_job;
 if v_count<5 then raise exception 'Durable submission receipts missing'; end if;
 if has_function_privilege('anon','public.record_client_visit_feedback_once(uuid,uuid,uuid,numeric,text,text[],text,integer)','execute')
  or has_function_privilege('authenticated','public.record_client_visit_feedback_once(uuid,uuid,uuid,numeric,text,text[],text,integer)','execute')
  or not has_function_privilege('service_role','public.record_client_visit_feedback_once(uuid,uuid,uuid,numeric,text,text[],text,integer)','execute') then raise exception 'Feedback execution grants changed'; end if;
 if has_table_privilege('anon','spotless_private.client_feedback_receipts','SELECT')
  or has_table_privilege('authenticated','spotless_private.client_feedback_receipts','SELECT') then raise exception 'Private receipts exposed'; end if;
end $$;
rollback;
