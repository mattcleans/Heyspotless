-- An unconfirmed payment claim holds its invoice until someone resolves it.
-- When no provider reference was saved, reconciliation has nothing to ask
-- Stripe about, so Management must be able to close the claim once they have
-- confirmed in Stripe that nothing was charged. No payment row is written here.
create function public.release_unconfirmed_payment_operation(
 p_operation_id uuid,p_actor_profile_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_op public.payment_operations%rowtype; v_attempt integer;
begin
 if p_operation_id is null or p_actor_profile_id is null then raise invalid_parameter_value; end if;
 if not exists(select 1 from public.profiles where id=p_actor_profile_id and role='admin') then
  raise insufficient_privilege using message='Management access is required.';
 end if;
 select * into v_op from public.payment_operations where id=p_operation_id;
 if v_op.id is null then return jsonb_build_object('released',false,'reason','not_found'); end if;
 -- Same order as begin_payment_operation: the invoice lock decides who wins.
 perform 1 from public.invoices where id=v_op.invoice_id for update;
 select * into v_op from public.payment_operations where id=p_operation_id for update;
 if v_op.state not in ('open','abandoned') then
  return jsonb_build_object('released',false,'reason','resolved');
 end if;
 -- An open claim with a provider reference is answered by a status check.
 if v_op.state='open' and v_op.stripe_object_id is not null then
  return jsonb_build_object('released',false,'reason','provider_reference');
 end if;
 -- Leave time for the request to finish and for a late webhook to land.
 if v_op.state='open' and v_op.created_at>clock_timestamp()-interval '30 minutes' then
  return jsonb_build_object('released',false,'reason','too_recent');
 end if;
 update public.payment_operations set state='failed',
  resolved_at=coalesce(resolved_at,clock_timestamp()),
  last_error='Released by Management after confirming no Stripe charge (profile '||p_actor_profile_id::text||')'
  where id=v_op.id;
 -- An automatic charge key is fixed per attempt. Spend this attempt so the
 -- next sweep uses a new key instead of finding this released one again.
 if v_op.channel='autocharge' and v_op.idempotency_key ~ '^autocharge:[^:]+:[0-9]{1,6}$' then
  v_attempt:=split_part(v_op.idempotency_key,':',3)::integer;
  update public.invoices set attempt_count=greatest(attempt_count,v_attempt),
   last_attempt_at=coalesce(last_attempt_at,v_op.created_at)
   where id=v_op.invoice_id;
 end if;
 return jsonb_build_object('released',true,'invoiceId',v_op.invoice_id,'channel',v_op.channel);
end $$;
revoke all on function public.release_unconfirmed_payment_operation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_unconfirmed_payment_operation(uuid,uuid) to service_role;
