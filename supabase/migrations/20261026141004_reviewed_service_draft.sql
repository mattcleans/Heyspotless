-- Management reviews the visit price before requesting a service draft.
-- Keep that price check and the existing evidence gate under one visit lock.
create function public.prepare_job_service_draft(p_job_id uuid,p_reviewed_price_cents integer)
returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype;
begin
 select * into j from public.jobs where id=p_job_id for update;
 if j.id is null or j.status<>'complete' then return null; end if;
 if p_reviewed_price_cents is null or p_reviewed_price_cents<0
  or j.price_cents is distinct from p_reviewed_price_cents then
  raise exception using errcode='PFD01',message='The visit price changed. Refresh and review it before preparing a draft.';
 end if;
 return public.settle_job_invoice(j.id);
end $$;
revoke all on function public.prepare_job_service_draft(uuid,integer) from public,anon,authenticated;
grant execute on function public.prepare_job_service_draft(uuid,integer) to service_role;
