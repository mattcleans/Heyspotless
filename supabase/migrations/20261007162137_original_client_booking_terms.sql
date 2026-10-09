-- Read only: Office can inspect the immutable Client request for a saved visit.
-- No private table grants; authorization uses the current trusted profile role.
create function public.read_office_booking_for_visit(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_review_id uuid;
begin
 if auth.uid() is null or public.current_role_of() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 perform id from public.profiles where id=auth.uid() and role='admin' for share;
 if not found then raise insufficient_privilege;end if;
 if p_job_id is null then raise exception 'Choose a saved visit' using errcode='22023';end if;
 select r.id into v_review_id
 from public.jobs j join spotless_private.client_booking_reviews r
 on r.customer_id=j.customer_id and r.property_id=j.property_id
 and (r.job_id=j.id or (r.plan_id is not null and r.plan_id=j.recurring_plan_id))
 where j.id=p_job_id and r.confirmed_at is not null;
 if v_review_id is null then return null;end if;
 return spotless_private.client_booking_view(v_review_id);
end $$;
revoke all on function public.read_office_booking_for_visit(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_office_booking_for_visit(uuid) to authenticated;
