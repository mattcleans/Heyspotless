-- Validate competing windows only after selecting this Cleaner's assignments.
-- SQL predicates may be reordered: an unrelated infinity fixture must not
-- reach visit_capacity_window before the assignment/owner filter runs.
create or replace function spotless_private.assert_cleaner_capacity(
 p_cleaner uuid,p_job uuid,p_status public.job_status,
 p_start timestamptz,p_end timestamptz,p_minutes integer,p_exclude_assignment uuid default null)
returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v_window tstzrange; v_other record;
begin
 if p_status in ('complete','canceled') then return; end if;
 v_window:=spotless_private.visit_capacity_window(p_start,p_end,p_minutes);
 if v_window is null then return; end if;
 for v_other in
  select j.scheduled_start,j.scheduled_end,j.estimated_clean_minutes
  from public.job_assignments a join public.jobs j on j.id=a.job_id
  where a.cleaner_id=p_cleaner and a.job_id<>p_job
   and (p_exclude_assignment is null or a.id<>p_exclude_assignment)
   and j.status not in ('complete','canceled') and j.scheduled_start is not null
 loop
  if spotless_private.visit_capacity_window(v_other.scheduled_start,v_other.scheduled_end,v_other.estimated_clean_minutes) && v_window then
   raise exception 'Another accepted visit overlaps this appointment' using errcode='PCP01';
  end if;
 end loop;
end $$;
