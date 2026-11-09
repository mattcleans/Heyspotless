-- Recheck visit state under the conflicting row lock before replaying a source write.
create or replace function public.import_job(
  p_hcp_id      text,
  p_customer_id uuid,
  p_property_id uuid,
  p_service     text,
  p_freq        frequency,
  p_price_cents integer,
  p_estimated_minutes integer,
  p_status      job_status,
  p_scheduled_start timestamptz default null,
  p_scheduled_end   timestamptz default null,
  p_completed_at    timestamptz default null,
  p_notes       text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into jobs (hcp_job_id, customer_id, property_id, service, freq,
                    price_cents, estimated_clean_minutes, status,
                    scheduled_start, scheduled_end, completed_at, notes)
  -- Cast rather than typed as `service_type` in the signature: the importer
  -- passes what it read from a CSV, and a cast here fails loudly on a value the
  -- book does not sell instead of PostgREST refusing the call with a less
  -- useful message.
  values (p_hcp_id, p_customer_id, p_property_id, p_service::service_type, p_freq,
          greatest(0, coalesce(p_price_cents, 0)),
          greatest(0, coalesce(p_estimated_minutes, 0)),
          p_status, p_scheduled_start, p_scheduled_end, p_completed_at, p_notes)
  on conflict (hcp_job_id) do update set
    status = excluded.status,
    price_cents = excluded.price_cents,
    scheduled_start = excluded.scheduled_start,
    scheduled_end = excluded.scheduled_end,
    completed_at = coalesce(jobs.completed_at, excluded.completed_at),
    notes = coalesce(jobs.notes, excluded.notes)
  where jobs.started_at is null
    and jobs.status not in ('assigned', 'in_progress')
    and not exists (select 1 from job_assignments where job_id = jobs.id and offer_id is not null)
  returning id into v_id;

  if v_id is null then
    raise exception 'Housecall Pro import cannot replace an assigned or started visit'
      using errcode = 'check_violation';
  end if;
  return v_id;
end $$;
