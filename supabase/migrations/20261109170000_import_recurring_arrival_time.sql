-- Use a required final argument to keep the existing RPC unambiguous.
create function public.import_recurring_plan(
  p_hcp_plan_id text,
  p_customer_id uuid,
  p_property_id uuid,
  p_freq public.frequency,
  p_service text,
  p_agreed_price_cents integer,
  p_estimated_minutes integer,
  p_anchor_date date,
  p_active boolean,
  p_start_time time
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_agreed_price_cents is null or p_agreed_price_cents <= 0 then
    raise exception 'a recurring plan cannot be imported without the price the customer pays'
      using errcode = 'check_violation';
  end if;
  if p_start_time = time '24:00' then
    raise exception 'recurring arrival must be a time within the day'
      using errcode = 'check_violation';
  end if;

  insert into recurring_plans (
    hcp_plan_id, customer_id, property_id, freq, service, agreed_price_cents,
    estimated_minutes, anchor_date, active, price_locked, start_time
  ) values (
    p_hcp_plan_id, p_customer_id, p_property_id, p_freq, p_service::service_type,
    p_agreed_price_cents, coalesce(p_estimated_minutes, 0), p_anchor_date,
    p_active, true, coalesce(p_start_time, time '09:00')
  )
  on conflict (hcp_plan_id) where hcp_plan_id is not null do update set
    freq = excluded.freq,
    agreed_price_cents = case when recurring_plans.price_locked
                              then recurring_plans.agreed_price_cents
                              else excluded.agreed_price_cents end,
    anchor_date = coalesce(recurring_plans.anchor_date, excluded.anchor_date),
    active = excluded.active
  where p_start_time is null or recurring_plans.start_time = excluded.start_time
  returning id into v_id;

  if v_id is null then
    raise exception 'review the existing recurring arrival time before importing'
      using errcode = 'check_violation';
  end if;
  return v_id;
end $$;

revoke all on function public.import_recurring_plan(text, uuid, uuid, public.frequency, text, integer, integer, date, boolean, time)
  from public, anon, authenticated;
grant execute on function public.import_recurring_plan(text, uuid, uuid, public.frequency, text, integer, integer, date, boolean, time)
  to service_role;

create or replace function public.import_recurring_plan(
  p_hcp_plan_id text,
  p_customer_id uuid,
  p_property_id uuid,
  p_freq public.frequency,
  p_service text,
  p_agreed_price_cents integer,
  p_estimated_minutes integer,
  p_anchor_date date,
  p_active boolean default true
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.import_recurring_plan(
    p_hcp_plan_id, p_customer_id, p_property_id, p_freq, p_service,
    p_agreed_price_cents, p_estimated_minutes, p_anchor_date, p_active, null::time
  )
$$;
