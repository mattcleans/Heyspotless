-- Disposable verifier/preview transaction only. No provider calls; all rollback.
begin;
do $$
declare p uuid:=gen_random_uuid(); c uuid; i uuid; r record; n integer;
begin
 insert into auth.users(id,email) values(p,'reviewed-collection-'||p::text||'@example.test');
 insert into customers(profile_id,first_name,last_name) values(p,'SYNTHETIC collection','Client') returning id into c;
 insert into invoices(customer_id,status,subtotal_cents,total_cents) values(c,'sent',19900,19900) returning id into i;
 perform set_invoice_tip(i,2000);
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-stale-tip-'||i,19900,19900,c);
  raise exception 'Stale pre-tip amount was collected';
 exception when sqlstate 'PT409' then null; end;
 if exists(select 1 from payment_operations where invoice_id=i) then raise exception 'Rejected balance left a collection attempt'; end if;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-current-'||i,21900,21900,c);
 if r.outcome is distinct from 'started' or r.amount_cents<>21900 then raise exception 'Current reviewed balance was not claimed'; end if;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-current-'||i,21900,21900,c);
 if r.outcome is distinct from 'existing' then raise exception 'Reviewed claim lost same-key idempotency'; end if;
 select * into r from begin_reviewed_payment_operation(i,'autocharge','SYNTHETIC-other-'||i,21900,21900,c);
 if r.outcome is distinct from 'blocked' then raise exception 'Reviewed claim permitted two collectors'; end if;
 select count(*) into n from payment_operations where invoice_id=i;
 if n<>1 then raise exception 'Reviewed claim duplicated attempts'; end if;
 update payment_operations set state='failed',resolved_at=now() where invoice_id=i;
 -- Credits and ownership must be reviewed afresh, even when a route held
 -- a valid older read of this invoice before waiting for its row lock.
 update invoices set credit_cents=2000 where id=i;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-stale-credit-'||i,21900,21900,c);
  raise exception 'Stale pre-credit amount was collected';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-wrong-owner-'||i,19900,19900,gen_random_uuid());
  raise exception 'Changed owner was ignored';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-wrong-sum-'||i,21000,19900,c,2000);
  raise exception 'Claim amount did not equal reviewed balance plus tip';
 exception when invalid_parameter_value then null; end;
 begin
  perform begin_reviewed_payment_operation(i,'autocharge','SYNTHETIC-sweep-tip-'||i,21900,19900,c,2000);
  raise exception 'Sweep added an unreviewed tip';
 exception when invalid_parameter_value then null; end;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-extra-tip-'||i,20900,19900,c,1000);
 if r.outcome is distinct from 'started' or r.amount_cents<>20900 then raise exception 'Reviewed additional Checkout tip was lost'; end if;
 update payment_operations set state='failed',resolved_at=now() where invoice_id=i and state='open';
 update invoices set status='void',voided_at=now() where id=i;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-void-'||i,19900,19900,c);
  raise exception 'Voided invoice was collected';
 exception when sqlstate 'PT409' then null; end;
 update invoices set status='draft',voided_at=null where id=i;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-draft-'||i,19900,19900,c);
  raise exception 'Draft invoice was collected';
 exception when sqlstate 'PT409' then null; end;
 update invoices set status='paid',amount_paid_cents=19900 where id=i;
 begin
  perform begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-paid-'||i,19900,19900,c);
  raise exception 'Settled invoice was collected';
 exception when sqlstate 'PT409' then null; end;
 if has_function_privilege('anon','public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)','EXECUTE')
  or has_function_privilege('authenticated','public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)','EXECUTE')
  or not has_function_privilege('service_role','public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)','EXECUTE') then raise exception 'Reviewed claim execution grants changed'; end if;
end $$;
rollback;
