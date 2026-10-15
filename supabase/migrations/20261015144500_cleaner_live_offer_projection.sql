-- Unassigned waterfall jobs remain private under jobs RLS. Project only the
-- offered cleaner's decision terms instead of joining through that RLS boundary.
create function public.read_my_live_job_offers(p_cleaner_id uuid)
returns table (
 id uuid, job_id uuid, cleaner_id uuid, payout_cents integer,
 estimated_minutes integer, expires_at timestamptz, is_exclusive boolean, jobs jsonb
)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or public.current_role_of() is distinct from 'cleaner'
 or p_cleaner_id is null or p_cleaner_id is distinct from public.current_cleaner_id()
 then raise insufficient_privilege; end if;
 return query
 select o.id,o.job_id,o.cleaner_id,o.payout_cents,o.estimated_minutes,o.expires_at,o.is_exclusive,
  jsonb_build_object('scheduled_start',j.scheduled_start,
   'customers',jsonb_build_object('first_name',c.first_name),
   'properties',jsonb_build_object('city',p.city))
 from public.offers o
 join public.jobs j on j.id=o.job_id
 join public.cleaners cl on cl.id=o.cleaner_id
 join public.customers c on c.id=j.customer_id
 join public.properties p on p.id=j.property_id
 where o.cleaner_id=p_cleaner_id and cl.status='active' and cl.type='contractor_1099'
  and o.status='sent' and o.expires_at>statement_timestamp()
  and o.schedule_revision=j.schedule_revision
  and j.status in ('unscheduled','scheduled','dispatching')
  and j.scheduled_start>statement_timestamp() and isfinite(j.scheduled_start)
 order by o.expires_at,o.id;
end $$;
revoke all on function public.read_my_live_job_offers(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_my_live_job_offers(uuid) to authenticated;
