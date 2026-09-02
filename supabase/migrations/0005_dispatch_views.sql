-- ============================================================================
-- 0005 — derived dispatch inputs
--
-- Two things the engine needs are not columns and must not be denormalised into
-- one, because they change every time a job is scheduled:
--
--   hours_scheduled_this_week — drives the guaranteed-hours and overtime split
--   last_stop_zip             — the origin for the drive estimate, and the
--                               reason route clustering can save ~$5,887/yr
--
-- Computed in the database so every caller agrees on what "this week" means.
-- security_invoker keeps row-level security applying to the underlying tables,
-- so a cleaner reading this view still cannot see another cleaner's load.
-- ============================================================================

create or replace view cleaner_week_load
with (security_invoker = true) as
with week as (
  select date_trunc('week', now())                        as start_at,
         date_trunc('week', now()) + interval '7 days'    as end_at
),
assigned as (
  select ja.cleaner_id,
         j.estimated_clean_minutes,
         j.scheduled_start,
         p.zip
  from job_assignments ja
  join jobs j       on j.id = ja.job_id
  join properties p on p.id = j.property_id
  cross join week w
  where j.scheduled_start >= w.start_at
    and j.scheduled_start <  w.end_at
    and j.status in ('scheduled', 'assigned', 'in_progress', 'complete')
)
select
  c.id                                                              as cleaner_id,
  coalesce(sum(a.estimated_clean_minutes)::numeric / 60, 0)         as hours_scheduled_this_week,
  (array_agg(a.zip order by a.scheduled_start desc))[1]             as last_stop_zip
from cleaners c
left join assigned a on a.cleaner_id = c.id
group by c.id;

comment on view cleaner_week_load is
  'Per-cleaner scheduled hours and last stop for the current week. Feeds '
  'w2MarginalCost() and the route clustering in lib/dispatch.';
