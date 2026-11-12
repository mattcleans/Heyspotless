-- Housecall Pro imports can populate missing counts from property defaults.
-- Use the existing home-baseline label so the office can review the terms.
create or replace function spotless_private.capture_inserted_plan_scope()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform spotless_private.capture_plan_room_scope(new.id, new.hcp_plan_id is not null);
  return new;
end $$;

create or replace function spotless_private.capture_inserted_job_scope()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform spotless_private.capture_job_room_scope(new.id, new.hcp_job_id is not null);
  return new;
end $$;

-- Relabel existing baselines without touching their counts, capture timestamps,
-- or scopes backed by accepted booking and quote receipts.
update public.recurring_plan_room_scopes s
set source = 'legacy_home'
from public.recurring_plans p
where s.plan_id = p.id and p.hcp_plan_id is not null and s.source = 'plan_created';

update public.job_room_scopes s
set source = 'legacy_home'
from public.jobs j
left join public.recurring_plans p on p.id = j.recurring_plan_id
where s.job_id = j.id
  and ((j.hcp_job_id is not null and s.source = 'visit_created')
    or (p.hcp_plan_id is not null and s.source = 'plan_created'));
