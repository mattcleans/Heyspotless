-- Settle an evidence-complete visit on Done, regardless of upload order.
-- CREATE OR REPLACE preserves the existing service-only execution grant.
create or replace function complete_job(
  p_job_id     uuid,
  p_cleaner_id uuid,
  p_lat        numeric default null,
  p_lng        numeric default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_plat numeric; v_plng numeric;
  v_distance integer;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return false; end if;

  if not exists (select 1 from job_assignments
                 where job_id = p_job_id and cleaner_id = p_cleaner_id) then
    return false;
  end if;

  -- Already done. A second tap is not a second clean.
  if v_job.status = 'complete' then
    -- Retry also repairs a completed visit left uninvoiced by the old path.
    perform settle_job_invoice(p_job_id);
    return true;
  end if;
  if v_job.status not in ('assigned', 'in_progress') then return false; end if;

  if p_lat is not null and p_lng is not null then
    select latitude, longitude into v_plat, v_plng
    from properties where id = v_job.property_id;

    if v_plat is not null and v_plng is not null then
      -- Equirectangular approximation. Accurate to well under a percent at the
      -- distances that matter here, and the question is "was she at the
      -- house", not "how far exactly".
      v_distance := round(
        6371000 * sqrt(
          pow(radians(p_lat - v_plat), 2) +
          pow(radians(p_lng - v_plng) * cos(radians((p_lat + v_plat) / 2)), 2)
        )
      );
    end if;
  end if;

  update jobs set
    status = 'complete',
    started_at = coalesce(started_at, now()),
    completed_at = now(),
    completion_distance_m = coalesce(v_distance, completion_distance_m)
  where id = p_job_id;

  update time_entries set
    clock_out_at = coalesce(clock_out_at, now()),
    clean_minutes = coalesce(
      clean_minutes,
      greatest(1, round(extract(epoch from (now() - clock_in_at)) / 60))::integer
    )
  where job_id = p_job_id and cleaner_id = p_cleaner_id and clock_out_at is null;

  -- Photos may already be durable before Done. Check the same invoice gate
  -- used by late photo uploads while the job row is still locked.
  perform settle_job_invoice(p_job_id);
  return true;
end $$;
