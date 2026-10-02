-- Disposable fixtures only. Pure policy checks pin Dallas midnight and DST.
begin;
grant select on public.invoices,public.visit_reschedules,public.jobs,public.job_assignments to authenticated;
do $$ begin
 if visit_reschedule_fee('2026-10-02T04:00Z','2026-10-02T04:30Z','2026-10-02T02:00Z')<>0 then raise exception 'same Dallas day should be free';end if;
 if visit_reschedule_fee('2026-10-02T04:00Z','2026-10-02T14:00Z','2026-10-02T02:00Z')<>6000 then raise exception 'Dallas next day fee missing';end if;
 if visit_reschedule_fee('2026-10-02T14:00Z','2026-10-03T14:00Z','2026-10-02T04:59Z')<>0 then raise exception 'previous evening charged';end if;
 if visit_reschedule_fee('2026-10-02T14:00Z','2026-10-03T14:00Z','2026-10-02T05:00Z')<>6000 then raise exception 'appointment midnight boundary wrong';end if;
 if visit_reschedule_fee('2026-11-01T06:30Z','2026-11-01T07:30Z','2026-11-01T05:00Z')<>0 then raise exception 'repeated hour charged';end if;
 if visit_reschedule_fee(null,'2026-10-03T14:00Z','2026-10-02T14:00Z')<>0 then raise exception 'unset appointment invented fee';end if;
 if visit_cancellation_fee('2026-10-02T14:00Z','cancel','2026-10-02T05:00Z')<>6000 or
    visit_cancellation_fee('2026-10-02T14:00Z','door_turnaway','2026-10-01T05:00Z')<>6000 then raise exception 'cancellation policy changed';end if;
end $$;
insert into auth.users(id,email) values
 ('c1000000-0000-0000-0000-000000000001','fee-a@example.test'),
 ('c1000000-0000-0000-0000-000000000002','fee-b@example.test');
insert into customers(id,profile_id,first_name,last_name) values
 ('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Fee','A'),
 ('c2000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002','Fee','B');
insert into properties(id,customer_id,street,city,zip) values
 ('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Sample','Dallas','75001');
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
 select ('c5000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,90,
 ((clock_timestamp() at time zone 'America/Chicago')::date+time '12:00') at time zone 'America/Chicago'
 from generate_series(1,2) n;
-- Keep an already-paid clean invoice; the additional fee must not replace it.
insert into invoices(id,job_id,customer_id,status,subtotal_cents,total_cents,amount_paid_cents) values
 ('c7000000-0000-0000-0000-000000000001','c5000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','paid',20000,20000,20000);
create temporary table fee_receipts(kind text,q jsonb,r jsonb);
grant all on fee_receipts to authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ declare q jsonb;r jsonb;target timestamptz:=((clock_timestamp() at time zone 'America/Chicago')::date+1+time '12:00') at time zone 'America/Chicago';begin
 q:=quote_my_visit_reschedule_with_fee('c5000000-0000-0000-0000-000000000001',target);
 if q->>'fee_cents'<>'6000' or q ? 'assignment_snapshot' then raise exception 'paid review missing fee/privacy';end if;
 if (select count(*) from invoices where kind='reschedule_fee' and customer_id='c2000000-0000-0000-0000-000000000001')<>0 then raise exception 'review issued fee';end if;
 r:=confirm_my_visit_reschedule('c5000000-0000-0000-0000-000000000001',(q->>'id')::uuid);
 if r->>'fee_cents'<>'6000' or r->>'invoice_id' is null or r->>'price_cents'<>'20000' then raise exception 'paid receipt invalid';end if;
 if confirm_my_visit_reschedule('c5000000-0000-0000-0000-000000000001',(q->>'id')::uuid)<>r then raise exception 'retry changed fee receipt';end if;
 insert into fee_receipts values('paid',q,r);
 insert into fee_receipts values('stale',quote_my_visit_reschedule('c5000000-0000-0000-0000-000000000002',target),null);
end $$;
reset role;
do $$ declare v_invoice uuid;begin
 select (r->>'invoice_id')::uuid into v_invoice from fee_receipts where kind='paid';
 if (select count(*) from invoices where kind='reschedule_fee' and customer_id='c2000000-0000-0000-0000-000000000001')<>1 then raise exception 'duplicate fee invoice';end if;
 if not exists(select 1 from invoices where id=v_invoice and customer_id='c2000000-0000-0000-0000-000000000001' and job_id is null
  and kind='reschedule_fee' and total_cents=6000 and tip_cents=0 and status='sent' and autocharge_paused_at is not null) then raise exception 'fee invoice shape wrong';end if;
 if not exists(select 1 from invoices where id='c7000000-0000-0000-0000-000000000001' and status='paid' and amount_paid_cents=20000) then raise exception 'service payment changed';end if;
 if exists(select 1 from visit_cancellations where job_id='c5000000-0000-0000-0000-000000000001') then raise exception 'move canceled visit';end if;
 begin perform begin_payment_operation(v_invoice,'autocharge','fee-auto',6000,900);raise exception 'fee autocharge allowed';exception when check_violation then null;end;
 perform begin_payment_operation(v_invoice,'checkout','fee-checkout',6000,900);
 if (select count(*) from payment_operations where invoice_id=v_invoice)<>1 then raise exception 'fee collection lock failed';end if;
end $$;
-- Simulate an old free review crossing the fee boundary: reject atomically.
update visit_reschedule_quotes set fee_cents=0 where id=(select (q->>'id')::uuid from fee_receipts where kind='stale');
set local role authenticated;
do $$ begin
 begin perform confirm_my_visit_reschedule('c5000000-0000-0000-0000-000000000002',(select (q->>'id')::uuid from fee_receipts where kind='stale'));
  raise exception 'unreviewed fee accepted';exception when serialization_failure then null;end;
 if (select count(*) from invoices where kind='reschedule_fee' and customer_id='c2000000-0000-0000-0000-000000000001')<>1 then raise exception 'stale confirmation issued fee';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from invoices where kind='reschedule_fee') or exists(select 1 from visit_reschedules where fee_cents=6000) then raise exception 'other client fee visible';end if;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','quote_my_visit_reschedule(uuid,timestamptz)','EXECUTE') or
    has_function_privilege('authenticated','visit_reschedule_fee(timestamptz,timestamptz,timestamptz)','EXECUTE') then raise exception 'private fee helper exposed';end if;
end $$;
rollback;
