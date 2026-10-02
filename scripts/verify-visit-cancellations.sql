-- Full-schema isolated regression; every fixture and mutation rolls back.
begin;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated;
grant select on profiles,customers,properties,jobs,job_assignments,invoices to authenticated;
insert into auth.users(id,email) values
 ('81000000-0000-0000-0000-000000000001','cancel-a@example.test'),
 ('81000000-0000-0000-0000-000000000002','cancel-b@example.test'),
 ('81000000-0000-0000-0000-000000000003','cancel-admin@example.test'),
 ('81000000-0000-0000-0000-000000000004','cancel-cleaner@example.test');
update profiles set role='admin' where id='81000000-0000-0000-0000-000000000003';
update profiles set role='cleaner' where id='81000000-0000-0000-0000-000000000004';
insert into customers(id,profile_id,first_name,last_name) values
 ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','Cancel','A'),
 ('82000000-0000-0000-0000-000000000002','81000000-0000-0000-0000-000000000002','Cancel','B');
insert into properties(id,customer_id,street,city,zip) values
 ('83000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','Sample A','Dallas','75001'),
 ('83000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000002','Sample B','Dallas','75001');
insert into cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared) values
 ('84000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000004','Cleaner','contractor_1099','active',4.5,true);
insert into recurring_plans(id,customer_id,property_id,service,freq,agreed_price_cents,estimated_minutes,anchor_date) values
 ('89000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001','standard','weekly',20000,60,current_date+7);
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start) select
 ('85000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '82000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,60,
 case when n in (2,3,6) then clock_timestamp() else clock_timestamp()+interval '7 days' end from generate_series(1,8) n;
update jobs set recurring_plan_id='89000000-0000-0000-0000-000000000001',occurrence_date=current_date+7,freq='weekly'
 where id='85000000-0000-0000-0000-000000000001';
update jobs set customer_id='82000000-0000-0000-0000-000000000002',property_id='83000000-0000-0000-0000-000000000002'
 where id='85000000-0000-0000-0000-000000000008';
insert into offers(id,job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at) values
 ('86000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','open_board',2000,2000,0.1,60,clock_timestamp()+interval '1 day');
-- Withdrawal must work even if the cleaner became inactive after the offer.
update cleaners set status='paused' where id='84000000-0000-0000-0000-000000000001';
insert into invoices(id,job_id,customer_id,status,subtotal_cents,total_cents,amount_paid_cents,issued_at) values
 ('87000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','sent',20000,20000,0,now()),
 ('87000000-0000-0000-0000-000000000003','85000000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000001','paid',20000,20000,20000,now()),
 ('87000000-0000-0000-0000-000000000005','85000000-0000-0000-0000-000000000005','82000000-0000-0000-0000-000000000001','sent',20000,20000,0,now());
insert into payments(id,invoice_id,customer_id,amount_cents,status,stripe_payment_intent_id,succeeded_at) values
 ('88000000-0000-0000-0000-000000000003','87000000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000001',20000,'succeeded','pi_cancel_fixture',now());
select begin_payment_operation('87000000-0000-0000-0000-000000000005','checkout','cancel-test-open',20000,900);
do $$ begin
 if visit_cancellation_fee('2026-10-02 14:00Z','cancel','2026-10-02 02:00Z')<>0 then raise exception 'previous evening charged'; end if;
 if visit_cancellation_fee('2026-10-02 02:00Z','cancel','2026-10-01 14:00Z')<>6000 then raise exception 'same Dallas day across UTC dates free'; end if;
 if visit_cancellation_fee('2026-11-01 16:00Z','cancel','2026-11-01 06:00Z')<>6000 then raise exception 'DST fee drift'; end if;
 if visit_cancellation_fee(null,'cancel',now())<>0 then raise exception 'unscheduled fee invented'; end if;
 if visit_cancellation_fee(null,'door_turnaway',now())<>6000 then raise exception 'door fee missing'; end if;
end $$;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ declare q jsonb; r jsonb; begin
 begin
  perform quote_my_visit_cancellation('85000000-0000-0000-0000-000000000008','cancel');
  raise exception 'other client quote allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform quote_my_visit_cancellation('85000000-0000-0000-0000-000000000002','door_turnaway');
  raise exception 'client door turnaway allowed';
 exception when invalid_parameter_value then null; end;
 begin
  perform quote_my_visit_cancellation('85000000-0000-0000-0000-000000000002','skip');
  raise exception 'non-recurring skip allowed';
 exception when invalid_parameter_value then null; end;
 q:=quote_my_visit_cancellation('85000000-0000-0000-0000-000000000001','skip');
 if q->>'fee_cents'<>'0' then raise exception 'future skip charged'; end if;
 if (select status from jobs where id='85000000-0000-0000-0000-000000000001')<>'scheduled' then raise exception 'review canceled visit'; end if;
 r:=confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000001',(q->>'id')::uuid);
 if r->>'reason'<>'skip' or (r->>'billing_review')::boolean or r->>'invoice_id' is not null then raise exception 'bad free skip receipt'; end if;
 if confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000001',(q->>'id')::uuid)<>r then raise exception 'retry receipt changed'; end if;
 q:=quote_my_visit_cancellation('85000000-0000-0000-0000-000000000002','cancel');
 if q->>'fee_cents'<>'6000' then raise exception 'same-day fee missing'; end if;
 r:=confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000002',(q->>'id')::uuid);
 if r->>'fee_cents'<>'6000' or r->>'invoice_id' is null then raise exception 'fee invoice missing'; end if;
 perform confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000002',(q->>'id')::uuid);
 q:=quote_my_visit_cancellation('85000000-0000-0000-0000-000000000003','cancel');
 r:=confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000003',(q->>'id')::uuid);
 if not (r->>'billing_review')::boolean or r->>'invoice_id' is not null then raise exception 'paid visit fee double invoiced'; end if;
 q:=quote_my_visit_cancellation('85000000-0000-0000-0000-000000000005','cancel');
 r:=confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000005',(q->>'id')::uuid);
 if not (r->>'billing_review')::boolean then raise exception 'in-flight collection not flagged'; end if;
 begin
  update visit_cancellations set fee_cents=0;
  raise exception 'client changed fee audit';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare r record; begin
 if not exists(select 1 from recurring_plan_skips where plan_id='89000000-0000-0000-0000-000000000001' and occurrence_date=current_date+7) then raise exception 'skip not saved'; end if;
 if (select active from recurring_plans where id='89000000-0000-0000-0000-000000000001') is not true then raise exception 'plan canceled'; end if;
 select * into r from materialise_recurring_job('89000000-0000-0000-0000-000000000001',current_date+7,now()+interval '7 days');
 if r.job_id is not null then raise exception 'generator recreated canceled occurrence'; end if;
 if (select status from offers where id='86000000-0000-0000-0000-000000000001')<>'withdrawn' then raise exception 'inactive cleaner offer not withdrawn'; end if;
 if respond_to_offer('86000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001',true,null)<>'superseded' then raise exception 'canceled offer accepted'; end if;
 if (select status from invoices where id='87000000-0000-0000-0000-000000000001')<>'void' then raise exception 'unperformed clean still collectible'; end if;
 if (select count(*) from invoices where job_id='85000000-0000-0000-0000-000000000002')<>1 then raise exception 'duplicate fee invoice'; end if;
 if (select total_cents from invoices where job_id='85000000-0000-0000-0000-000000000002')<>6000 then raise exception 'wrong fee invoice'; end if;
 if (select autocharge_paused_at from invoices where id='87000000-0000-0000-0000-000000000003') is null then raise exception 'paid invoice not paused'; end if;
 if (select amount_paid_cents from invoices where id='87000000-0000-0000-0000-000000000003')<>20000 then raise exception 'cancellation rewrote captured payment'; end if;
 begin
  perform begin_payment_operation('87000000-0000-0000-0000-000000000001','checkout','canceled-new-payment',20000,900);
  raise exception 'void service invoice recollected';
 exception when check_violation then null; end;
 begin
  perform begin_payment_operation('87000000-0000-0000-0000-000000000003','checkout','paid-canceled-new-payment',6000,900);
  raise exception 'canceled paid invoice recollected';
 exception when check_violation then null; end;
 perform begin_payment_operation((select invoice_id from visit_cancellations where job_id='85000000-0000-0000-0000-000000000002'),'checkout','fee-checkout',6000,900);
 begin
  update jobs set status='assigned' where id='85000000-0000-0000-0000-000000000002';
  raise exception 'old dispatch reopened cancellation';
 exception when check_violation then null; end;
end $$;
-- Quotes belong to the actor and exact visit/time; changed appointments,
-- expired reviews, altered fees, started work and changed owners all reject.
create temp table cancel_quote_fixture(id uuid,job_id uuid);
grant all on cancel_quote_fixture to authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
set local role authenticated;
insert into cancel_quote_fixture select (q->>'id')::uuid,'85000000-0000-0000-0000-000000000004'::uuid from (select quote_my_visit_cancellation('85000000-0000-0000-0000-000000000004','cancel') q) x;
reset role;
update jobs set scheduled_start=scheduled_start+interval '1 hour' where id='85000000-0000-0000-0000-000000000004';
set local role authenticated;
do $$ begin
 begin
  perform confirm_my_visit_cancellation((select job_id from cancel_quote_fixture),(select id from cancel_quote_fixture));
  raise exception 'stale appointment canceled';
 exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
update visit_cancellation_quotes set scheduled_start=(select scheduled_start from jobs where id=job_id),expires_at=now()-interval '1 minute' where id=(select id from cancel_quote_fixture);
set local role authenticated;
do $$ begin
 begin
  perform confirm_my_visit_cancellation((select job_id from cancel_quote_fixture),(select id from cancel_quote_fixture));
  raise exception 'expired quote canceled';
 exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
update visit_cancellation_quotes set expires_at=clock_timestamp()+interval '5 minutes',fee_cents=6000 where id=(select id from cancel_quote_fixture);
set local role authenticated;
do $$ begin
 begin
  perform confirm_my_visit_cancellation((select job_id from cancel_quote_fixture),(select id from cancel_quote_fixture));
  raise exception 'changed day fee bypassed';
 exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
update visit_cancellation_quotes set fee_cents=0 where id=(select id from cancel_quote_fixture);
update jobs set status='in_progress',started_at=now() where id='85000000-0000-0000-0000-000000000004';
set local role authenticated;
do $$ begin
 begin
  perform confirm_my_visit_cancellation((select job_id from cancel_quote_fixture),(select id from cancel_quote_fixture));
  raise exception 'started visit canceled';
 exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from visit_cancellations) then raise exception 'other client read cancellation'; end if;
 if exists(select 1 from visit_cancellation_quotes) then raise exception 'other client read quote'; end if;
 begin
  perform confirm_my_visit_cancellation((select job_id from cancel_quote_fixture),(select id from cancel_quote_fixture));
  raise exception 'other client reused quote';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000004',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from visit_cancellations) then raise exception 'cleaner read client fee history'; end if;
 begin
  perform quote_my_visit_cancellation('85000000-0000-0000-0000-000000000006','cancel');
  raise exception 'cleaner canceled visit';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
 begin
  perform resolve_visit_cancellation_billing('85000000-0000-0000-0000-000000000003',(select id from visit_cancellations where job_id='85000000-0000-0000-0000-000000000003'));
  raise exception 'office collected fee before refunding existing payment';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform resolve_visit_cancellation_billing('85000000-0000-0000-0000-000000000005',(select id from visit_cancellations where job_id='85000000-0000-0000-0000-000000000005'));
  raise exception 'office settled live payment attempt';
 exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
-- Provider-confirmed refund, locally recorded using the existing ledger RPC.
select record_refund('pi_cancel_fixture',20000,'re_cancel_fixture',null,'Canceled visit','goodwill','succeeded');
set local role authenticated;
do $$ declare r jsonb; again jsonb; begin
 r:=resolve_visit_cancellation_billing('85000000-0000-0000-0000-000000000003',(select id from visit_cancellations where job_id='85000000-0000-0000-0000-000000000003'));
 again:=resolve_visit_cancellation_billing('85000000-0000-0000-0000-000000000003',(r->>'id')::uuid);
 if r<>again or (r->>'billing_review')::boolean or r->>'invoice_id' is null then raise exception 'billing resolution not idempotent'; end if;
end $$;
do $$ declare q jsonb;r jsonb; begin
 q:=quote_my_visit_cancellation('85000000-0000-0000-0000-000000000007','door_turnaway');
 r:=confirm_my_visit_cancellation('85000000-0000-0000-0000-000000000007',(q->>'id')::uuid);
 if r->>'fee_cents'<>'6000' or r->>'reason'<>'door_turnaway' then raise exception 'door fee missing'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
 begin
  perform quote_my_visit_cancellation('85000000-0000-0000-0000-000000000006','cancel');
  raise exception 'anonymous cancellation allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
