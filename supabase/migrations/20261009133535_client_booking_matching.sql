-- A Client booking kickoff expires only offers on its owned visit. The
-- restricted server function follows the existing dispatch write boundary;
-- no Client/anonymous execute grant or broader table-write grant is added.
create function public.expire_stale_offers_for_job(p_job_id uuid) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  if p_job_id is null then raise exception 'visit required' using errcode='22023';end if;
  update public.offers set status='expired',responded_at=clock_timestamp()
    where job_id=p_job_id and status='sent' and expires_at<=clock_timestamp();
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.expire_stale_offers_for_job(uuid) from public,anon,authenticated,service_role;
grant execute on function public.expire_stale_offers_for_job(uuid) to service_role;
