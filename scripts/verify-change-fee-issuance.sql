-- Disposable local/CI fixtures. No provider calls; every mutation rolls back.
begin;
insert into auth.users(id,email) values
 ('fa100000-0000-4000-8000-000000000001','change-client@example.test'),
 ('fa100000-0000-4000-8000-000000000002','change-admin@example.test');
update public.profiles set role='admin' where id='fa100000-0000-4000-8000-000000000002';
insert into public.customers(id,profile_id,first_name,last_name) values
 ('fa200000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000001','Change','Client');
insert into public.properties(id,customer_id,street,city,zip) values
 ('fa300000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','Synthetic change review','Dallas','75001');
insert into public.jobs(id,customer_id,property_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes)
select ('fa500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'fa200000-0000-4000-8000-000000000001','fa300000-0000-4000-8000-000000000001','scheduled','standard','one_time',clock_timestamp(),19900,90 from generate_series(1,2) n;
select set_config('request.jwt.claim.sub','fa100000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.confirm_my_visit_cancellation('fa500000-0000-4000-8000-000000000001',(public.quote_my_visit_cancellation('fa500000-0000-4000-8000-000000000001','cancel')->>'id')::uuid);
select public.confirm_my_visit_reschedule('fa500000-0000-4000-8000-000000000002',(public.quote_my_visit_reschedule_with_fee('fa500000-0000-4000-8000-000000000002',date_trunc('minute',clock_timestamp()+interval '2 days'))->>'id')::uuid);
reset role;
do $$
declare i public.invoices%rowtype;v_change uuid;v_job uuid;r jsonb;again jsonb;d date:=(clock_timestamp() at time zone 'America/Chicago')::date+1;
begin
 if has_function_privilege('anon','public.issue_reviewed_change_fee(uuid,uuid,text,uuid,integer,date)','execute') or has_function_privilege('authenticated','public.issue_reviewed_change_fee(uuid,uuid,text,uuid,integer,date)','execute') then raise exception 'Fee issuance exposed to Client';end if;
 if has_table_privilege('authenticated','spotless_private.change_fee_issuances','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('service_role','spotless_private.change_fee_issuances','INSERT,UPDATE,DELETE') then raise exception 'Fee audit directly writable';end if;
 if (select count(*) from public.invoices where customer_id='fa200000-0000-4000-8000-000000000001' and status='draft' and issued_at is null and job_id is null and total_cents=6000)<>2 then raise exception 'Change auto-issued or lost fee';end if;
 for i in select * from public.invoices where customer_id='fa200000-0000-4000-8000-000000000001' order by id loop
  if i.kind='cancellation_fee' then select id,job_id into v_change,v_job from public.visit_cancellations where invoice_id=i.id;
  else select id,job_id into v_change,v_job from public.visit_reschedules where invoice_id=i.id;end if;
  begin perform public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000001',6000,d);raise exception 'Client actor forged';exception when insufficient_privilege then null;end;
  begin perform public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000002',5999,d);raise exception 'Changed amount issued';exception when invalid_parameter_value then null;end;
  begin perform public.issue_reviewed_change_fee(i.id,gen_random_uuid(),i.kind,'fa100000-0000-4000-8000-000000000002',6000,d);raise exception 'Changed receipt issued';exception when sqlstate 'PIF01' then null;end;
  begin perform public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000002',6000,d-2);raise exception 'Past due date issued';exception when sqlstate 'PIF01' then null;end;
  begin perform public.begin_payment_operation(i.id,'checkout','unissued:'||i.id,6000,900);raise exception 'Draft fee collected';exception when check_violation then null;end;
  r:=public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000002',6000,d);
  again:=public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000002',6000,d);
  if r<>again or r->>'invoiceId'<>i.id::text or r->>'visitId'<>v_job::text or r->>'changeId'<>v_change::text or r->>'kind'<>i.kind then raise exception 'Fee issue receipt mismatch';end if;
  begin perform public.issue_reviewed_change_fee(i.id,v_change,i.kind,'fa100000-0000-4000-8000-000000000002',6000,d+1);raise exception 'Stale due date accepted';exception when sqlstate 'PIF01' then null;end;
  begin perform public.begin_payment_operation(i.id,'autocharge','auto:'||i.id,6000,900);raise exception 'Fee automatically collected';exception when check_violation then null;end;
  perform public.begin_payment_operation(i.id,'checkout','reviewed:'||i.id,6000,900);
  perform public.begin_payment_operation(i.id,'checkout','reviewed:'||i.id,6000,900);
  if (select count(*) from public.payment_operations where invoice_id=i.id)<>1 then raise exception 'Duplicate fee collection claim';end if;
  if not exists(select 1 from spotless_private.change_fee_issuances where invoice_id=i.id and change_id=v_change and job_id=v_job and kind=i.kind and issued_by='fa100000-0000-4000-8000-000000000002' and total_cents=6000 and due_on=d) then raise exception 'Fee audit mismatch';end if;
 end loop;
 if exists(select 1 from public.payments where customer_id='fa200000-0000-4000-8000-000000000001') then raise exception 'Issuance invented payment';end if;
 if (select count(*) from spotless_private.change_fee_issuances where customer_id='fa200000-0000-4000-8000-000000000001')<>2 then raise exception 'Issuance audit duplicated';end if;
 raise notice 'Change fees: Client-confirmed drafts, exact Management review, idempotent issuance, no autocharge, one checkout claim';
end $$;
rollback;
