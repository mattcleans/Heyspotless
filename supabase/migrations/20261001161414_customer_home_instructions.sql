-- Customers may edit only instructions on their own homes. The trigger also
-- protects columns when a client writes directly through the Data API.
create or replace function public.guard_customer_property_updates()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role::text = 'customer') then
    return new;
  end if;
  if (to_jsonb(new) - array['gate_code','access_notes','parking_notes','pets'])
    is distinct from (to_jsonb(old) - array['gate_code','access_notes','parking_notes','pets']) then
    raise exception 'customers may edit home instructions only' using errcode = '42501';
  end if;
  if char_length(new.gate_code) > 200 or char_length(new.access_notes) > 1000
    or char_length(new.parking_notes) > 1000 or char_length(new.pets) > 1000 then
    raise exception 'home instructions exceed the allowed length' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.guard_customer_property_updates() from public, anon, authenticated, service_role;
create trigger guard_customer_property_updates before update on public.properties
  for each row execute function public.guard_customer_property_updates();

create policy properties_customer_instructions on public.properties for update to authenticated
using (customer_id = public.current_customer_id()
  and exists (select 1 from public.profiles where id = auth.uid() and role::text = 'customer'))
with check (customer_id = public.current_customer_id()
  and exists (select 1 from public.profiles where id = auth.uid() and role::text = 'customer'));
-- Existing administrator privileges remain. Even where authenticated already
-- has table UPDATE, the trigger above restricts customer writes to four fields.
grant update (gate_code, access_notes, parking_notes, pets) on public.properties to authenticated;

create or replace function public.set_my_home_instructions(
  p_property_id uuid, p_gate_code text, p_access_notes text,
  p_parking_notes text, p_pets text, p_expected jsonb
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_before public.properties%rowtype;
  v_current jsonb;
  v_values jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role::text = 'customer') then
    raise exception 'customer account required' using errcode = '42501';
  end if;
  if p_expected is null or jsonb_typeof(p_expected) <> 'object'
    or not (p_expected ?& array['gateCode','accessNotes','parkingNotes','pets'])
    or (p_expected - array['gateCode','accessNotes','parkingNotes','pets']) <> '{}'::jsonb
    or exists (select 1 from jsonb_each(p_expected) e where jsonb_typeof(e.value) not in ('string','null')) then
    raise exception 'original instructions required' using errcode = '22023';
  end if;
  if char_length(p_gate_code) > 200 or char_length(p_access_notes) > 1000
    or char_length(p_parking_notes) > 1000 or char_length(p_pets) > 1000 then
    raise exception 'home instructions exceed the allowed length' using errcode = '22023';
  end if;
  select * into v_before from public.properties
    where id = p_property_id and customer_id = public.current_customer_id() for update;
  if not found then raise exception 'own home required' using errcode = '42501'; end if;
  v_current := jsonb_build_object('gateCode',v_before.gate_code,'accessNotes',v_before.access_notes,
    'parkingNotes',v_before.parking_notes,'pets',v_before.pets);
  v_values := jsonb_build_object('gateCode',nullif(btrim(p_gate_code),''),'accessNotes',nullif(btrim(p_access_notes),''),
    'parkingNotes',nullif(btrim(p_parking_notes),''),'pets',nullif(btrim(p_pets),''));
  -- A retry after a lost response can safely confirm the already-saved values.
  if v_current = v_values then return v_current; end if;
  if v_current is distinct from p_expected then
    raise exception 'home instructions changed; review latest values' using errcode = '40001';
  end if;
  update public.properties set gate_code = v_values->>'gateCode', access_notes = v_values->>'accessNotes',
    parking_notes = v_values->>'parkingNotes', pets = v_values->>'pets'
    where id = p_property_id and customer_id = public.current_customer_id();
  return v_values;
end $$;
revoke all on function public.set_my_home_instructions(uuid,text,text,text,text,jsonb) from public, anon, service_role;
grant execute on function public.set_my_home_instructions(uuid,text,text,text,text,jsonb) to authenticated;
