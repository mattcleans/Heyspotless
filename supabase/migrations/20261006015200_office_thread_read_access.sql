-- Marking a thread read is an office action. Use the caller's table privileges
-- and RLS rather than the function owner's access, with an explicit role check.
create or replace function public.mark_thread_read(
  p_customer_id uuid default null,
  p_cleaner_id uuid default null,
  p_lead_id uuid default null
) returns integer
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if current_user <> 'service_role'
     and (auth.uid() is null or not coalesce(public.is_admin(), false)) then
    raise insufficient_privilege;
  end if;
  update public.messages set read_at = now()
   where direction = 'inbound' and read_at is null
     and ( (p_customer_id is not null and customer_id = p_customer_id)
        or (p_cleaner_id is not null and cleaner_id = p_cleaner_id)
        or (p_lead_id is not null and lead_id = p_lead_id) );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.mark_thread_read(uuid, uuid, uuid) from public, anon;
grant execute on function public.mark_thread_read(uuid, uuid, uuid)
  to authenticated, service_role;
