-- Weekly estimates follow Dallas Monday–Sunday dates and caller RLS.
create view public.cleaner_week_load_by_week
with (security_invoker = true) as
select a.cleaner_id,
 date_trunc('week', j.scheduled_start at time zone 'America/Chicago')::date as week_start,
 sum(j.estimated_clean_minutes)::numeric / 60 as scheduled_clean_hours
from public.job_assignments a join public.jobs j on j.id=a.job_id
where j.status in ('scheduled','assigned','in_progress','complete')
 and j.scheduled_start is not null and isfinite(j.scheduled_start)
group by a.cleaner_id, date_trunc('week', j.scheduled_start at time zone 'America/Chicago')::date;

revoke all on public.cleaner_week_load_by_week from public,anon;
grant select on public.cleaner_week_load_by_week to authenticated,service_role;
comment on view public.cleaner_week_load_by_week is
 'Estimated assigned cleaning hours by Dallas Monday week. Excludes travel and canceled visits; caller RLS applies.';

-- Keep existing consumers and column names; correct their current-week boundary.
create or replace view public.cleaner_week_load
with (security_invoker = true) as
with week as (
 select date_trunc('week', now() at time zone 'America/Chicago') at time zone 'America/Chicago' as start_at,
  (date_trunc('week', now() at time zone 'America/Chicago') + interval '7 days') at time zone 'America/Chicago' as end_at
), assigned as (
 select a.cleaner_id,j.estimated_clean_minutes,j.scheduled_start,p.zip
 from public.job_assignments a join public.jobs j on j.id=a.job_id
 join public.properties p on p.id=j.property_id cross join week w
 where j.scheduled_start>=w.start_at and j.scheduled_start<w.end_at
 and j.status in ('scheduled','assigned','in_progress','complete')
)
select c.id as cleaner_id,
 coalesce(sum(a.estimated_clean_minutes)::numeric / 60,0) as hours_scheduled_this_week,
 (array_agg(a.zip order by a.scheduled_start desc))[1] as last_stop_zip
from public.cleaners c left join assigned a on a.cleaner_id=c.id group by c.id;
comment on view public.cleaner_week_load is
 'Estimated assigned cleaning hours and last stop for the current Dallas Monday–Sunday week. Excludes travel; caller RLS applies.';
