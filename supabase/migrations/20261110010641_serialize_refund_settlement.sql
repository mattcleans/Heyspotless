-- Refund status must be read under the same row lock that guards its effects.
create or replace function settle_refund(
  p_stripe_refund_id text,
  p_status           refund_status
) returns text
language plpgsql security definer set search_path = public as $$
declare v_refund refunds%rowtype;
begin
  select * into v_refund from refunds where stripe_refund_id = p_stripe_refund_id
  for update;
  if v_refund.id is null then return 'unknown'; end if;

  -- Already settled. A webhook replay, and a no-op.
  if v_refund.status = p_status then return 'unchanged'; end if;

  if v_refund.status <> 'pending' then
    -- Stripe does not un-succeed a refund; if it appears to, that is worth a
    -- person looking rather than money moving twice.
    raise exception 'refund % is already %, refusing to make it %',
      p_stripe_refund_id, v_refund.status, p_status;
  end if;

  if p_status = 'succeeded' then
    update refunds set status = 'succeeded', succeeded_at = now() where id = v_refund.id;
    perform apply_refund_effects(v_refund.id);
    return 'succeeded';
  end if;

  update refunds set status = p_status where id = v_refund.id;
  return p_status::text;
end $$;
