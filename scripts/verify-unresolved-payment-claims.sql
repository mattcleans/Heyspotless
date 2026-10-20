-- Disposable fixtures only. Provider outcomes below are explicitly synthetic.
begin;
do $$ declare c uuid; i uuid; r record; old_id uuid; retry_id uuid; retry_key text; n integer; begin
 insert into customers(first_name,last_name) values('SYNTHETIC pending','Client') returning id into c;
 insert into invoices(customer_id,status,subtotal_cents,total_cents) values(c,'sent',17000,17000) returning id into i;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-unknown-'||i,17000,17000,c);
 old_id:=r.operation_id;
 update payment_operations set expires_at=clock_timestamp()-interval '1 second' where id=old_id;
 if (open_payment_operation(i)).id is distinct from old_id then raise exception 'Local expiry hid the unresolved operation'; end if;
 select * into r from begin_reviewed_payment_operation(i,'autocharge','SYNTHETIC-new-'||i,17000,17000,c);
 if r.outcome is distinct from 'blocked' or r.operation_id is distinct from old_id then raise exception 'Expired unknown operation permitted another collection'; end if;
 if not exists(select 1 from payment_operations where id=old_id and state='open') then raise exception 'Unknown operation was abandoned'; end if;
 -- An attached provider object is also unresolved until its actual outcome.
 perform attach_payment_operation('SYNTHETIC-unknown-'||i,'checkout_session','cs_SYNTHETIC_'||i,'https://example.test/SYNTHETIC');
 if (open_payment_operation(i)).stripe_object_id is distinct from 'cs_SYNTHETIC_'||i then raise exception 'Expired provider identity could not be reconciled'; end if;
 select * into r from begin_reviewed_payment_operation(i,'autocharge','SYNTHETIC-new-'||i,17000,17000,c);
 if r.outcome is distinct from 'blocked' then raise exception 'Attached expired operation allowed another collector'; end if;
 select count(*) into n from payment_operations where invoice_id=i;
 if n<>1 then raise exception 'Unresolved request duplicated its operation'; end if;
 -- Fixture: provider has definitively confirmed no payment can still settle.
 perform resolve_payment_operation('SYNTHETIC-unknown-'||i,'failed','SYNTHETIC confirmed terminal outcome');
 select * into r from begin_reviewed_payment_operation(i,'autocharge','SYNTHETIC-new-'||i,17000,17000,c);
 if r.outcome is distinct from 'started' or r.operation_id=old_id then raise exception 'Confirmed terminal outcome did not release invoice'; end if;
 perform resolve_payment_operation('SYNTHETIC-new-'||i,'failed','SYNTHETIC confirmed terminal');
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-unknown-'||i,17000,17000,c);
 if r.outcome is distinct from 'started' or r.idempotency_key<>'SYNTHETIC-unknown-'||i||':retry:1' then raise exception 'Finished Checkout reused its old provider key'; end if;
 retry_id:=r.operation_id; retry_key:=r.idempotency_key;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-unknown-'||i,17000,17000,c);
 if r.outcome is distinct from 'existing' or r.operation_id<>retry_id or r.idempotency_key<>retry_key then raise exception 'Concurrent retry generation did not collapse'; end if;
 perform resolve_payment_operation(retry_key,'failed','SYNTHETIC confirmed terminal');
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-unknown-'||i,17000,17000,c);
 if r.outcome is distinct from 'started' or r.idempotency_key<>'SYNTHETIC-unknown-'||i||':retry:2' then raise exception 'Second finished Checkout replayed an earlier generation'; end if;
 if exists(select 1 from payments where customer_id=c) then raise exception 'Fixture invented a payment'; end if;
 if has_function_privilege('authenticated','public.open_payment_operation(uuid)','EXECUTE')
  or has_function_privilege('anon','public.begin_payment_operation(uuid,public.payment_operation_channel,text,integer,integer)','EXECUTE')
  or not has_function_privilege('service_role','public.open_payment_operation(uuid)','EXECUTE') then raise exception 'Payment execution grants changed'; end if;
end $$;
rollback;
