-- The HTTP route reads a balance before it claims an operation. A tip, credit
-- or payment can commit between those steps, including while this lock waits.
-- Keep the original claim/idempotency protocol, but validate its reviewed
-- balance under the very same invoice lock before creating any operation.
create function public.begin_reviewed_payment_operation(
 p_invoice_id uuid,p_channel public.payment_operation_channel,p_idempotency_key text,
 p_amount_cents integer,p_expected_balance_cents integer,p_expected_customer_id uuid,p_tip_cents integer default 0,
 p_ttl_seconds integer default 900
) returns table(
 outcome text,operation_id uuid,channel public.payment_operation_channel,
 idempotency_key text,stripe_object_id text,stripe_object_kind text,
 redirect_url text,amount_cents integer
) language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_invoice public.invoices%rowtype;
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
 return query select * from public.begin_payment_operation(
  p_invoice_id,p_channel,p_idempotency_key,p_amount_cents,coalesce(p_ttl_seconds,900));
end $$;
revoke all on function public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)
 from public,anon,authenticated;
grant execute on function public.begin_reviewed_payment_operation(uuid,public.payment_operation_channel,text,integer,integer,uuid,integer,integer)
 to service_role;
