-- Isolated preview/disposable CI only. Every synthetic row rolls back.
begin;
do $$
declare
 a uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); k uuid:=gen_random_uuid();
 customer_a uuid; customer_b uuid; invoice_a uuid; invoice_b uuid;
 operation_a uuid; operation_b uuid; actor uuid; n integer;
begin
 insert into auth.users(id,email,raw_user_meta_data) values
  (a,'payment-review-'||a||'@example.test','{}'),
  (c,'payment-review-'||c||'@example.test','{}'),
  (o,'payment-review-'||o||'@example.test','{}'),
  (k,'payment-review-'||k||'@example.test','{}');
 update public.profiles set role='admin' where id=a;
 update public.profiles set role='cleaner' where id=k;
 insert into public.customers(profile_id,first_name,last_name) values(c,'SYNTHETIC','Payment Review A') returning id into customer_a;
 insert into public.customers(profile_id,first_name,last_name) values(o,'SYNTHETIC','Payment Review B') returning id into customer_b;
 insert into public.invoices(customer_id,status,subtotal_cents,total_cents) values(customer_a,'sent',19900,19900) returning id into invoice_a;
 insert into public.invoices(customer_id,status,subtotal_cents,total_cents) values(customer_b,'sent',21900,21900) returning id into invoice_b;
 insert into public.payment_operations(invoice_id,channel,idempotency_key,amount_cents,expires_at)
  values(invoice_a,'checkout','SYNTHETIC-review-'||invoice_a,19900,now()-interval '1 day') returning id into operation_a;
 insert into public.payment_operations(invoice_id,channel,idempotency_key,amount_cents,expires_at)
  values(invoice_b,'autocharge','SYNTHETIC-review-'||invoice_b,21900,now()+interval '1 day') returning id into operation_b;
 foreach actor in array array[a,c,o,k] loop
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.payment_operations po
   join public.invoices i on i.id=po.invoice_id join public.customers cu on cu.id=i.customer_id
   where po.id in (operation_a,operation_b) and po.state in ('open','abandoned');
  if n<>(case when actor=a then 2 when actor=k then 0 else 1 end) then raise exception 'Payment review join exposed or hid another actor records'; end if;
  if actor=c and exists(select 1 from public.payment_operations where id=operation_b) then raise exception 'Client saw another Client request'; end if;
  if actor=o and exists(select 1 from public.payment_operations where id=operation_a) then raise exception 'Other Client saw first request'; end if;
  execute 'reset role';
 end loop;
 perform set_config('request.jwt.claim.sub','',true);
 perform set_config('request.jwt.claims','{}',true);
 execute 'set local role anon';
 begin
  select count(*) into n from public.payment_operations where id in (operation_a,operation_b);
  if n<>0 then raise exception 'Anonymous actor saw payment requests'; end if;
 exception when insufficient_privilege then null; end;
 execute 'reset role';
 raise notice 'Payment review access passed: office sees both linked requests, Clients only their own, Cleaner and anonymous see none.';
end $$;
rollback;
