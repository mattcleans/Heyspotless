-- Unknown or processing payments must not become collectible again merely
-- because a local request deadline elapsed. No historical rows are changed.
create or replace function begin_payment_operation(
  p_invoice_id      uuid,
  p_channel         payment_operation_channel,
  p_idempotency_key text,
  p_amount_cents    integer,
  p_ttl_seconds     integer default 900
) returns table (
  outcome        text,
  operation_id   uuid,
  channel        payment_operation_channel,
  idempotency_key text,
  stripe_object_id   text,
  stripe_object_kind text,
  redirect_url   text,
  amount_cents   integer
)
language plpgsql security definer set search_path = pg_catalog,public,pg_temp as $$
declare
  v_open payment_operations%rowtype;
  v_outcome text;
begin
  if p_amount_cents <= 0 then
    raise exception 'a collection attempt must be for a positive amount, got %', p_amount_cents;
  end if;

  -- Serialise every decision about this invoice's collection on the invoice
  -- row. Two tabs arriving together is the ordinary case, not the exotic one.
  perform 1 from invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice % not found', p_invoice_id; end if;

  -- A local deadline is not a provider outcome. Keep the operation open
  -- until reconciliation confirms success or that no money can still move.
  select po.* into v_open from payment_operations po
  where po.invoice_id = p_invoice_id and po.state = 'open';

  if v_open.id is null then
    -- A key that has already been used and resolved is not a fresh attempt.
    -- Repeated submissions of the same form land here after the first one
    -- finished, and must not collect a second time.
    select po.* into v_open from payment_operations po
    where po.idempotency_key = p_idempotency_key;
    if v_open.id is not null then v_outcome := 'existing'; end if;
  elsif v_open.idempotency_key = p_idempotency_key then
    v_outcome := 'existing';
  else
    v_outcome := 'blocked';
  end if;

  if v_outcome is null then
    insert into payment_operations as po
      (invoice_id, channel, idempotency_key, amount_cents, expires_at)
    values (p_invoice_id, p_channel, p_idempotency_key, p_amount_cents,
            clock_timestamp() + make_interval(secs => p_ttl_seconds))
    returning po.* into v_open;
    v_outcome := 'started';
  end if;

  return query select v_outcome, v_open.id, v_open.channel, v_open.idempotency_key,
                      v_open.stripe_object_id, v_open.stripe_object_kind,
                      v_open.redirect_url, v_open.amount_cents;
end $$;

create or replace function public.open_payment_operation(p_invoice_id uuid)
returns public.payment_operations
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select * from public.payment_operations where invoice_id=p_invoice_id and state='open' limit 1;
$$;
revoke all on function public.begin_payment_operation(uuid,public.payment_operation_channel,text,integer,integer) from public,anon,authenticated;
grant execute on function public.begin_payment_operation(uuid,public.payment_operation_channel,text,integer,integer) to service_role;
revoke all on function public.open_payment_operation(uuid) from public,anon,authenticated;
grant execute on function public.open_payment_operation(uuid) to service_role;


-- The HTTP route reads a balance before it claims an operation. A tip, credit
-- or payment can commit between those steps, including while this lock waits.
-- Keep the original claim/idempotency protocol, but validate its reviewed
-- balance under the very same invoice lock before creating any operation.
create or replace function public.begin_reviewed_payment_operation(
 p_invoice_id uuid,p_channel public.payment_operation_channel,p_idempotency_key text,
 p_amount_cents integer,p_expected_balance_cents integer,p_expected_customer_id uuid,p_tip_cents integer default 0,
 p_ttl_seconds integer default 900
) returns table(
 outcome text,operation_id uuid,channel public.payment_operation_channel,
 idempotency_key text,stripe_object_id text,stripe_object_kind text,
 redirect_url text,amount_cents integer
) language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_invoice public.invoices%rowtype; v_prior public.payment_operations%rowtype; v_key text:=p_idempotency_key; v_generation bigint;
begin
 if p_expected_balance_cents is null or p_expected_customer_id is null or p_tip_cents is null or p_tip_cents<0
  or p_amount_cents is null
  or p_amount_cents::bigint<>p_expected_balance_cents::bigint+p_tip_cents::bigint
  or (p_channel='autocharge' and p_tip_cents<>0) then
  raise invalid_parameter_value;
 end if;
 select i.* into v_invoice from public.invoices i where i.id=p_invoice_id for update;
 if v_invoice.id is null or v_invoice.voided_at is not null
  or v_invoice.status not in ('sent','overdue') or v_invoice.balance_cents<=0
  or v_invoice.customer_id<>p_expected_customer_id
  or v_invoice.balance_cents<>p_expected_balance_cents
  or p_tip_cents>v_invoice.subtotal_cents then
  raise exception using errcode='PT409',message='The bill changed. Review its current balance before paying.';
 end if;
 -- Same-base concurrent requests share the live server-assigned key.
 select * into v_prior from public.payment_operations po
  where po.invoice_id=p_invoice_id and po.state='open' limit 1;
 if v_prior.id is not null then
  if v_prior.channel=p_channel and (v_prior.idempotency_key=p_idempotency_key
   or left(v_prior.idempotency_key,length(p_idempotency_key)+7)=p_idempotency_key||':retry:') then
   v_key:=v_prior.idempotency_key;
  end if;
 elsif p_channel='checkout' then
  select * into v_prior from public.payment_operations po
   where po.invoice_id=p_invoice_id and po.channel='checkout' and po.state='abandoned'
    and (po.idempotency_key=p_idempotency_key or left(po.idempotency_key,length(p_idempotency_key)+7)=p_idempotency_key||':retry:') limit 1;
  if v_prior.id is not null then
   return query select 'blocked'::text,v_prior.id,v_prior.channel,v_prior.idempotency_key,
    v_prior.stripe_object_id,v_prior.stripe_object_kind,null::text,v_prior.amount_cents;
   return;
  end if;
  select count(*) into v_generation from public.payment_operations po
   where po.invoice_id=p_invoice_id and po.channel='checkout' and po.state in ('succeeded','failed')
    and (po.idempotency_key=p_idempotency_key or left(po.idempotency_key,length(p_idempotency_key)+7)=p_idempotency_key||':retry:');
  if v_generation>0 then
   -- Count under the invoice lock; simultaneous retries share this generation.
   -- Unlike creation timestamps this also orders several retries in one txn.
   v_key:=p_idempotency_key||':retry:'||v_generation::text;
  end if;
 end if;
 return query select * from public.begin_payment_operation(
  p_invoice_id,p_channel,v_key,p_amount_cents,coalesce(p_ttl_seconds,900));
end $$;
revoke all on function public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)
 from public,anon,authenticated;
grant execute on function public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)
 to service_role;
