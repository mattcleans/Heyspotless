-- ============================================================================
-- 0020 — a job that can actually finish
--
-- POLICY (Matt, 16 September 2026): tapping done completes the job; done plus
-- the photo set raises the invoice. Two photos per room, one before and one
-- after.
--
-- WHAT WAS BROKEN. The job lifecycle runs
-- unscheduled -> scheduled -> dispatching -> assigned -> in_progress ->
-- complete, and everything built so far stopped at `assigned`. NOTHING IN THE
-- CODEBASE COULD SET A JOB TO COMPLETE. A cleaner accepted work and the system
-- never heard from her again.
--
-- That is not a gap at the end, it is a gap in the middle, because the
-- continuity engine reads from it: `job_continuity` counts incumbency from
-- `prior.status = 'complete'`. With nothing able to write that, every property
-- reported zero prior visits for ever and every customer read "no
-- relationship". The incumbent hold — the core marketplace promise, two
-- migrations and a policy decision — could never engage. The first live
-- dispatch run returning `held: 0` was not the seed being thin; it was this.
--
-- Downstream of the same missing event: no invoice, so no payment and no
-- payout; no ratings, so the 3.9 eligibility floor has nothing feeding it; and
-- "manager interventions per 100 COMPLETED cleans" has no denominator.
--
-- BEFORE PHOTOS NEED AN ARRIVAL. A photo taken before the clean has to be taken
-- before the clean, so `in_progress` stops being a state the system skips.
-- That is worth having anyway: arrival time is a real operational signal and it
-- comes free.
-- ============================================================================

-- --------------------------------------------------------------- jobs ------
alter table jobs
  add column started_at   timestamptz,
  add column completed_at timestamptz,
  /**
   * WHERE SHE WAS WHEN SHE TAPPED DONE, AS A DISTANCE. Never a coordinate.
   *
   * This is an attestation, not tracking, and the difference is the whole
   * point. One reading at one moment, reduced immediately to "how far from the
   * property", answers the only question worth asking — was she there when she
   * said she was. A log of where a contractor physically was, retained
   * indefinitely, is a liability with no use, and continuous location is the
   * kind of behavioural control that decides a worker-classification argument
   * (build plan §09).
   *
   * Null means the phone could not get a fix, which is ordinary: cleaners work
   * indoors, which is where GPS is worst.
   */
  add column completion_distance_m integer
    check (completion_distance_m is null or completion_distance_m >= 0),
  -- Set when the evidence is in and the invoice has been raised, so the gate
  -- is answerable without recounting photos.
  add column invoiced_at timestamptz;

comment on column jobs.completion_distance_m is
  'Metres between the cleaner and the property when she tapped done. An '
  'attestation, never a track: one reading, stored as a distance, no '
  'coordinate retained. Null means no fix was available, which is ordinary '
  'indoors and never blocks completion. See 0020.';

-- The exception queue's working set: finished, evidence incomplete, unbilled.
create index jobs_complete_unbilled on jobs (completed_at)
  where status = 'complete' and invoiced_at is null;

-- ------------------------------------------------------- job photos --------
alter table job_photos
  add constraint job_photos_kind_known
    check (kind in ('before', 'after', 'issue'));

/**
 * One photo of each kind per room per job.
 *
 * `issue` is exempt: a room can have several things wrong with it, and a
 * cleaner who finds a second problem must be able to photograph it. The
 * constraint exists for `before` and `after`, where a second one is a
 * duplicate upload from a retrying offline queue rather than new evidence.
 */
create unique index job_photos_one_per_room_kind
  on job_photos (job_id, room_key, kind)
  where room_key is not null and kind in ('before', 'after');

create index on job_photos (job_id, taken_at);

-- ============================================================================
-- STARTING AND FINISHING
-- ============================================================================

/**
 * She has arrived and is starting.
 *
 * Idempotent: tapping start twice does not move `started_at`, because when she
 * arrived is the fact, and a second tap is a person checking the button
 * worked.
 */
create or replace function start_job(
  p_job_id     uuid,
  p_cleaner_id uuid
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_job jobs%rowtype;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return false; end if;

  -- Only the cleaner it was assigned to. An offer she never accepted is not a
  -- job she can start.
  if not exists (select 1 from job_assignments
                 where job_id = p_job_id and cleaner_id = p_cleaner_id) then
    return false;
  end if;

  if v_job.status not in ('assigned', 'in_progress') then return false; end if;

  update jobs set
    status = 'in_progress',
    started_at = coalesce(started_at, now())
  where id = p_job_id;

  insert into time_entries (job_id, cleaner_id, clock_in_at)
  values (p_job_id, p_cleaner_id, now())
  on conflict do nothing;

  return true;
end $$;

/**
 * She has finished.
 *
 * COMPLETION IS NEVER BLOCKED BY EVIDENCE. She has left; the house is clean;
 * nothing should stop her closing out her day. Whether we may bill for it is a
 * separate question answered by `settle_job_invoice`, and it can be answered
 * later — photos upload late from a house with no signal.
 *
 * The distance is computed here rather than trusted from the client, and the
 * coordinate is discarded in the same statement that uses it.
 */
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
  if v_job.status = 'complete' then return true; end if;
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

  return true;
end $$;

/**
 * Raise the invoice if the job is done and the evidence is in.
 *
 * CALLED FROM BOTH EVENTS — the job completing and a photo arriving — because
 * either can be the one that completes the pair. Checking only at completion
 * would leave every job with a slow upload permanently uninvoiced.
 *
 * Returns the invoice id, or null when the gate is not yet satisfied. Null is
 * the ordinary answer on every photo but the last.
 *
 * The invoice is raised at the price on the JOB, which for a recurring visit is
 * the rate snapshotted from the plan (0014) rather than today's price book.
 */
create or replace function settle_job_invoice(p_job_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_required integer;
  v_have integer;
  v_invoice uuid;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then return null; end if;
  if v_job.status <> 'complete' then return null; end if;
  if v_job.invoiced_at is not null then
    select id into v_invoice from invoices where job_id = p_job_id limit 1;
    return v_invoice;
  end if;

  -- Rooms this property has, counted the same way lib/service/rooms.ts does.
  -- A zero count contributes nothing, so a flat with no utility room is not
  -- waiting on a photograph of one.
  select greatest(coalesce(p.kitchens, 1), 0) + greatest(p.bathrooms, 0)
       + greatest(coalesce(p.half_baths, 0), 0) + greatest(coalesce(p.living_rooms, 1), 0)
       + greatest(p.bedrooms, 0) + greatest(coalesce(p.utility_rooms, 1), 0)
  into v_required
  from properties p where p.id = v_job.property_id;

  select count(*) into v_have from (
    select room_key from job_photos
    where job_id = p_job_id and room_key is not null and kind in ('before', 'after')
    group by room_key having count(distinct kind) = 2
  ) done;

  if v_have < v_required then return null; end if;

  insert into invoices (job_id, customer_id, status, subtotal_cents, total_cents)
  values (p_job_id, v_job.customer_id, 'draft', v_job.price_cents, v_job.price_cents)
  returning id into v_invoice;

  update jobs set invoiced_at = now() where id = p_job_id;
  return v_invoice;
end $$;

/**
 * Record a photo, and settle the invoice if it was the last one needed.
 *
 * One call so the two cannot drift apart — a photo recorded without the gate
 * being re-checked is a job that stays uninvoiced until something else happens
 * to look at it.
 */
create or replace function record_job_photo(
  p_job_id       uuid,
  p_cleaner_id   uuid,
  p_storage_path text,
  p_kind         text,
  p_room_key     text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into job_photos (job_id, cleaner_id, storage_path, kind, room_key)
  values (p_job_id, p_cleaner_id, p_storage_path, p_kind, p_room_key)
  -- A retrying offline queue re-uploading the same shot is not new evidence.
  on conflict (job_id, room_key, kind)
    where room_key is not null and kind in ('before', 'after')
  do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from job_photos
    where job_id = p_job_id and room_key = p_room_key and kind = p_kind;
  end if;

  perform settle_job_invoice(p_job_id);
  return v_id;
end $$;

-- ------------------------------------------------------- row level security
-- A cleaner may photograph a job she is assigned to. 0003 already gave her
-- select on her own job_photos; this is the write half, and it is scoped the
-- same way rather than trusting the client to send its own cleaner id.
create policy job_photos_insert_own on job_photos for insert
  with check (
    cleaner_id = current_cleaner_id()
    and exists (select 1 from job_assignments ja
                where ja.job_id = job_photos.job_id
                  and ja.cleaner_id = current_cleaner_id())
  );

revoke all on function start_job(uuid, uuid) from public, anon, authenticated;
revoke all on function complete_job(uuid, uuid, numeric, numeric)
  from public, anon, authenticated;
revoke all on function settle_job_invoice(uuid) from public, anon, authenticated;
revoke all on function record_job_photo(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function start_job(uuid, uuid) to service_role;
grant execute on function complete_job(uuid, uuid, numeric, numeric) to service_role;
grant execute on function settle_job_invoice(uuid) to service_role;
grant execute on function record_job_photo(uuid, uuid, text, text, text) to service_role;
