-- Disposable fixtures only. Every synthetic row rolls back. No provider is called.
begin;
do $$
declare
 a uuid:=gen_random_uuid(); cu uuid:=gen_random_uuid();
 c uuid; i uuid; i2 uuid; i3 uuid; r record; j jsonb; op uuid; n integer;
begin
 insert into auth.users(id,email,raw_user_meta_data) values
  (a,'release-'||a||'@example.test','{}'),(cu,'release-'||cu||'@example.test','{}');
 update public.profiles set role='admin' where id=a;
 insert into public.customers(profile_id,first_name,last_name) values(cu,'SYNTHETIC','Release Client') returning id into c;
 insert into public.invoices(customer_id,status,subtotal_cents,total_cents) values(c,'sent',17000,17000) returning id into i;

 -- A Checkout claim whose provider response was never saved.
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-lost-'||i,17000,17000,c);
 op:=r.operation_id;

 begin
  perform release_unconfirmed_payment_operation(op,cu);
  raise exception 'A Client released an unconfirmed payment claim';
 exception when insufficient_privilege then null;
 end;

 j:=release_unconfirmed_payment_operation(op,a);
 if j->>'reason' is distinct from 'too_recent' then raise exception 'A fresh claim was released: %',j; end if;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-lost-'||i,17000,17000,c);
 if r.operation_id is distinct from op then raise exception 'A refused release stopped holding the invoice'; end if;

 update payment_operations set created_at=now()-interval '1 hour' where id=op;
 j:=release_unconfirmed_payment_operation(op,a);
 if (j->>'released')::boolean is not true then raise exception 'Reviewed claim was not released: %',j; end if;
 if not exists(select 1 from payment_operations where id=op and state='failed' and resolved_at is not null
   and last_error like 'Released by Management%') then
  raise exception 'Released claim did not record who released it';
 end if;
 j:=release_unconfirmed_payment_operation(op,a);
 if j->>'reason' is distinct from 'resolved' then raise exception 'A released claim was released twice: %',j; end if;
 select * into r from begin_reviewed_payment_operation(i,'checkout','SYNTHETIC-lost-'||i,17000,17000,c);
 if r.outcome is distinct from 'started' or r.idempotency_key<>'SYNTHETIC-lost-'||i||':retry:1' then
  raise exception 'Released Checkout did not allow a fresh provider key: % %',r.outcome,r.idempotency_key;
 end if;

 -- An open claim with a provider reference is answered by a status check.
 perform attach_payment_operation(r.idempotency_key,'checkout_session','cs_SYNTHETIC_'||i,'https://example.test/SYNTHETIC');
 update payment_operations set created_at=now()-interval '1 hour' where id=r.operation_id;
 j:=release_unconfirmed_payment_operation(r.operation_id,a);
 if j->>'reason' is distinct from 'provider_reference' then raise exception 'A reconcilable claim was released: %',j; end if;

 -- An older abandoned Checkout blocks its key until a person resolves it.
 insert into public.invoices(customer_id,status,subtotal_cents,total_cents) values(c,'sent',19900,19900) returning id into i2;
 insert into payment_operations(invoice_id,channel,idempotency_key,amount_cents,expires_at,state,resolved_at,stripe_object_id,stripe_object_kind)
  values(i2,'checkout','SYNTHETIC-old-'||i2,19900,now()-interval '2 days','abandoned',now()-interval '1 day','cs_SYNTHETIC_old','checkout_session')
  returning id into op;
 select * into r from begin_reviewed_payment_operation(i2,'checkout','SYNTHETIC-old-'||i2,19900,19900,c);
 if r.outcome is distinct from 'blocked' then raise exception 'Fixture: abandoned Checkout did not block'; end if;
 j:=release_unconfirmed_payment_operation(op,a);
 if (j->>'released')::boolean is not true then raise exception 'Abandoned claim was not released: %',j; end if;
 select * into r from begin_reviewed_payment_operation(i2,'checkout','SYNTHETIC-old-'||i2,19900,19900,c);
 if r.outcome is distinct from 'started' then raise exception 'Released abandoned Checkout still blocked'; end if;

 -- A released automatic charge spends its attempt, so the next key is new.
 insert into public.invoices(customer_id,status,subtotal_cents,total_cents) values(c,'sent',21900,21900) returning id into i3;
 select * into r from begin_reviewed_payment_operation(i3,'autocharge','autocharge:'||i3||':1',21900,21900,c);
 op:=r.operation_id;
 update payment_operations set created_at=now()-interval '1 hour' where id=op;
 j:=release_unconfirmed_payment_operation(op,a);
 if (j->>'released')::boolean is not true then raise exception 'Automatic claim was not released: %',j; end if;
 if (select attempt_count from invoices where id=i3)<>1 then raise exception 'Released automatic charge did not spend its attempt'; end if;
 select * into r from begin_reviewed_payment_operation(i3,'autocharge','autocharge:'||i3||':2',21900,21900,c);
 if r.outcome is distinct from 'started' then raise exception 'Next automatic attempt was blocked'; end if;

 if exists(select 1 from payments where customer_id=c) then raise exception 'Release invented a payment'; end if;
 select count(*) into n from invoices where customer_id=c and balance_cents<>total_cents;
 if n<>0 then raise exception 'Release changed an invoice balance'; end if;
 if has_function_privilege('authenticated','public.release_unconfirmed_payment_operation(uuid,uuid)','EXECUTE')
  or has_function_privilege('anon','public.release_unconfirmed_payment_operation(uuid,uuid)','EXECUTE')
  or not has_function_privilege('service_role','public.release_unconfirmed_payment_operation(uuid,uuid)','EXECUTE') then
  raise exception 'Release execution grants changed';
 end if;
end $$;
rollback;
