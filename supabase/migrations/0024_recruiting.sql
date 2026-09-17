-- ============================================================================
-- 0024 — supply
--
-- Phase 08, and the build plan calls it launch-critical for a reason that has
-- nothing to do with the apply form: **an auction with four cleaners is not an
-- auction.** Every mechanism in 0015 through 0018 — the ladder, the tiers, the
-- waterfall, the marginal-cost ceiling — assumes somebody is competing for the
-- work. With one contractor on the roster the escalation runs to the top rung
-- every time and the engine is an expensive way to pay 49%.
--
-- TWO THINGS THIS MIGRATION FIXES, AND THE SECOND IS THE ONE THAT MATTERS.
--
-- 1. There is no way in. `applications` has existed since 0001 with nothing
--    inserting a row and nothing turning one into a cleaner.
--
-- 2. THE FUNNEL LEADS NOWHERE. This is the serious one. The eligibility gate in
--    0003 reads `coalesce(c.rating, 0) >= 3.9`, so a cleaner with no rating is
--    ineligible for everything. A brand-new cleaner has no rating BY
--    DEFINITION. So every cleaner this funnel produces would be activated,
--    appear on the roster, and never be offered a single job — silently,
--    because "no eligible cleaner" is an ordinary dispatch outcome that looks
--    exactly like a quiet week.
--
--    `lib/dispatch/eligibility.ts` has said "new cleaners are seeded with a
--    provisional rating during onboarding" since it was written. Nothing has
--    ever done that seeding, because onboarding did not exist. This is where
--    that promise gets kept.
--
-- AND A THIRD THING, WHICH 0022 GOT WRONG. `record_rating` set the cleaner's
-- standing to the plain average of her ratings. On a new cleaner that means one
-- three-star review — from one customer, on one clean, on her first week — puts
-- her under the 3.9 floor and ends her career on the platform. A floor that can
-- be triggered by a single data point is not a quality bar, it is a lottery.
-- 0024 replaces it with the same average taken against a prior, which is the
-- standard fix and is spelled out below.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 24 $$;

-- ----------------------------------------------------------- the prior -----
/**
 * What we assume about a cleaner nobody has rated yet.
 *
 * ABOVE THE FLOOR, DELIBERATELY. The alternative — start her at zero and let
 * ratings lift her — means she is ineligible until a rating exists, and a
 * rating cannot exist until she has done a job she was never offered. The
 * funnel deadlocks.
 *
 * 4.2 rather than 5.0 because it is not a compliment, it is an estimate, and
 * starting everybody at the top makes the first real rating a punishment
 * however good it is.
 */
create or replace function provisional_cleaner_rating() returns numeric
language sql immutable as $$ select 4.2::numeric $$;

/**
 * How much that assumption is worth, in ratings.
 *
 * The prior is treated as if it were this many reviews already in the book, so
 * a cleaner's standing is
 *
 *     (PRIOR_WEIGHT * 4.2 + sum of real scores) / (PRIOR_WEIGHT + count)
 *
 * At five, one three-star on a new cleaner gives (5*4.2 + 3)/6 = 4.0 — she is
 * marked down and stays eligible. Sustained threes cross the floor at around
 * the eighth, which is a pattern rather than a bad Tuesday. A cleaner with
 * forty ratings is barely affected by the prior at all, which is correct: by
 * then we know.
 *
 * WHY A PRIOR AND NOT A MINIMUM COUNT. "Ignore the floor until five ratings"
 * would mean a genuinely bad cleaner gets four more houses before anybody can
 * act. This marks her down immediately and proportionally, which is the same
 * protection without the blind spot.
 */
create or replace function rating_prior_weight() returns numeric
language sql immutable as $$ select 5::numeric $$;

/**
 * Recompute a cleaner's standing against the prior.
 *
 * Replaces the plain average 0022 used. Same shape, same column, same reason
 * for being denormalised onto `cleaners`: the eligibility gate is a CHECK and a
 * CHECK cannot run an aggregate.
 */
create or replace function recompute_cleaner_rating(p_cleaner_id uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_sum numeric; v_count integer; v_rating numeric;
  v_w numeric := rating_prior_weight();
begin
  select coalesce(sum(score), 0), count(*) into v_sum, v_count
    from ratings where cleaner_id = p_cleaner_id;

  v_rating := round((v_w * provisional_cleaner_rating() + v_sum) / (v_w + v_count), 2);

  update cleaners set rating = v_rating where id = p_cleaner_id;
  return v_rating;
end $$;

/** 0022's version, now delegating. The rating path is unchanged for callers. */
create or replace function record_rating(
  p_job_id  uuid,
  p_score   numeric,
  p_comment text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer_id uuid;
  v_cleaner_id  uuid;
  v_status      job_status;
  v_id          uuid;
begin
  select j.customer_id, j.status into v_customer_id, v_status
    from jobs j where j.id = p_job_id;

  if v_customer_id is null then return null; end if;
  if v_status <> 'complete' then return null; end if;

  select ja.cleaner_id into v_cleaner_id
    from job_assignments ja
   where ja.job_id = p_job_id
   order by ja.is_lead desc, ja.assigned_at
   limit 1;

  if v_cleaner_id is null then return null; end if;

  insert into ratings (job_id, cleaner_id, customer_id, score, comment)
  values (p_job_id, v_cleaner_id, v_customer_id, greatest(1, least(5, p_score)), p_comment)
  on conflict (job_id, customer_id) do update
    set score = excluded.score, comment = excluded.comment
  returning id into v_id;

  perform recompute_cleaner_rating(v_cleaner_id);
  return v_id;
end $$;

-- -------------------------------------------------------- applications -----
/**
 * What somebody tells us when they apply.
 *
 * The columns 0001 shipped cover the screen; these cover the things that decide
 * whether she can be DISPATCHED, which is a different list. Service zips,
 * transport and insurance are all eligibility inputs, and collecting them at
 * activation rather than at application means the office chases them by phone.
 */
alter table applications
  add column service_zips text[] not null default '{}',
  add column desired_type cleaner_type,
  add column has_own_insurance boolean,
  add column insurance_expires_on date,
  add column referral_source text,
  /** The screen's answers, as asked. Free-form because the questions change. */
  add column screen_answers jsonb,
  /** Storage paths for whatever was uploaded. Never the documents themselves. */
  add column documents jsonb,
  add column sms_consent_at timestamptz,
  add column sms_consent_text text,
  add column rejected_reason text,
  add column reviewed_by uuid references profiles(id) on delete set null,
  add column status_changed_at timestamptz not null default now();

create index applications_open on applications (submitted_at)
  where status in ('submitted', 'screened', 'background_pending', 'background_cleared');

/**
 * An application, from the public form.
 *
 * Service-role only for the same reason `record_lead` is: the caller is an
 * anonymous request, and letting a browser insert into `applications` directly
 * would let it choose `status`, `screen_score` and `cleaner_id` — which is a
 * way to arrive pre-approved.
 */
create or replace function record_application(
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_phone      text,
  p_years_experience numeric default null,
  p_has_vehicle boolean default null,
  p_work_authorized boolean default null,
  p_service_zips text[] default '{}',
  p_desired_type cleaner_type default 'contractor_1099',
  p_has_own_insurance boolean default null,
  p_referral_source text default null,
  p_screen_answers jsonb default null,
  p_sms_consent_text text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into applications (
    first_name, last_name, email, phone, years_experience, has_vehicle,
    work_authorized, service_zips, desired_type, has_own_insurance,
    referral_source, screen_answers, sms_consent_at, sms_consent_text
  ) values (
    p_first_name, p_last_name, p_email, p_phone, p_years_experience, p_has_vehicle,
    p_work_authorized, coalesce(p_service_zips, '{}'), p_desired_type, p_has_own_insurance,
    p_referral_source, p_screen_answers,
    case when p_sms_consent_text is not null and p_phone is not null then now() end,
    p_sms_consent_text
  )
  returning id into v_id;

  return v_id;
end $$;

/**
 * Move an application along, one legal step at a time.
 *
 * WHY A STATE MACHINE AND NOT AN UPDATE. The order of these states is the
 * hiring process, and two of the transitions are load-bearing rather than
 * cosmetic: nobody reaches `background_cleared` without somebody recording that
 * the check came back, and nobody reaches `activated` except through
 * `activate_cleaner`, which is the only thing that can create a cleaner.
 *
 * Rejection is reachable from anywhere and is not reversible here — a rejected
 * application that turns out to be a mistake is a new application, which leaves
 * an honest record of what happened rather than an edited one.
 */
create or replace function advance_application(
  p_id      uuid,
  p_status  application_status,
  p_reason  text default null,
  p_by      uuid default null,
  p_score   numeric default null,
  p_notes   text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_current application_status;
  v_allowed boolean;
begin
  select status into v_current from applications where id = p_id for update;
  if v_current is null then return false; end if;

  v_allowed := case
    when p_status = 'rejected' then v_current <> 'activated'
    when p_status = 'screened' then v_current = 'submitted'
    when p_status = 'background_pending' then v_current in ('submitted', 'screened')
    when p_status = 'background_cleared' then v_current = 'background_pending'
    -- Only activate_cleaner writes this, and it calls in with the row locked.
    when p_status = 'activated' then false
    else false
  end;

  if not v_allowed then return false; end if;

  update applications set
    status = p_status,
    status_changed_at = now(),
    rejected_reason = case when p_status = 'rejected' then p_reason else rejected_reason end,
    reviewed_by = coalesce(p_by, reviewed_by),
    screen_score = coalesce(p_score, screen_score),
    screen_notes = coalesce(p_notes, screen_notes),
    background_check_ref = case
      when p_status = 'background_pending' then coalesce(p_reason, background_check_ref)
      else background_check_ref end
  where id = p_id;

  return true;
end $$;

/**
 * Turn a cleared application into somebody dispatch can actually offer work to.
 *
 * THE FOUR THINGS THIS DOES THAT AN INSERT WOULD NOT.
 *
 *   1. IT REFUSES AN UNCLEARED APPLICATION. `background_check_cleared` is
 *      described in 0003 as never overridable, and the way to keep that true is
 *      for the only path into `cleaners` to check it.
 *   2. IT SEEDS THE PROVISIONAL RATING. Without this she is on the roster and
 *      invisible to dispatch for ever — see the header. This is the line that
 *      makes the whole funnel worth building.
 *   3. IT REQUIRES INSURANCE OF A CONTRACTOR. A 1099 cleaner working uninsured
 *      is the business's liability, and the gate reads the expiry date, so an
 *      activation with no date would pass the gate for ever rather than fail
 *      it. `setup.md` item 9 is the decision this enforces.
 *   4. IT IS IDEMPOTENT. A second call returns the cleaner already created
 *      rather than a duplicate roster entry — two rows for one person would
 *      double-count her hours and let her hold two offers on one job.
 */
create or replace function activate_cleaner(
  p_application_id uuid,
  p_type           cleaner_type default null,
  p_profile_id     uuid default null,
  p_hourly_rate_cents integer default null,
  p_guaranteed_hours  numeric default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_app applications;
  v_cleaner_id uuid;
  v_type cleaner_type;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null then return null; end if;

  -- Already done. Returning the existing cleaner makes a retried request
  -- harmless rather than a second person on the roster.
  if v_app.cleaner_id is not null then return v_app.cleaner_id; end if;

  if v_app.status <> 'background_cleared' then
    raise exception 'application % is %, not background_cleared', p_application_id, v_app.status
      using errcode = 'check_violation';
  end if;

  v_type := coalesce(p_type, v_app.desired_type, 'contractor_1099');

  if v_type = 'contractor_1099' and v_app.insurance_expires_on is null then
    raise exception 'a contractor cannot be activated without insurance on file'
      using errcode = 'check_violation';
  end if;

  insert into cleaners (
    profile_id, full_name, type, status,
    rating, background_check_cleared, insurance_expires_on, service_zips,
    hourly_rate_cents, guaranteed_hours_per_week, default_payout_rate
  ) values (
    p_profile_id,
    trim(v_app.first_name || ' ' || coalesce(v_app.last_name, '')),
    v_type,
    'active',
    -- The line the funnel exists for.
    provisional_cleaner_rating(),
    true,
    v_app.insurance_expires_on,
    coalesce(v_app.service_zips, '{}'),
    case when v_type = 'w2_core' then p_hourly_rate_cents end,
    case when v_type = 'w2_core' then p_guaranteed_hours end,
    case when v_type = 'contractor_1099' then 0.33 end
  )
  returning id into v_cleaner_id;

  update applications set
    status = 'activated',
    status_changed_at = now(),
    cleaner_id = v_cleaner_id
  where id = p_application_id;

  return v_cleaner_id;
end $$;

-- ------------------------------------------------------- row level security
/**
 * An application is somebody's employment history, their phone number and their
 * right-to-work answer. Admin-only, which `0003`'s blanket admin policy already
 * provides — and nothing else, which is the point. There is deliberately no
 * "applicants read their own": they have no account, and giving them one to
 * check a status would mean an auth record for everybody who ever applied.
 */
revoke all on function record_application(text, text, text, text, numeric, boolean, boolean,
                                          text[], cleaner_type, boolean, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function advance_application(uuid, application_status, text, uuid, numeric, text)
  from public, anon, authenticated;
revoke all on function activate_cleaner(uuid, cleaner_type, uuid, integer, numeric)
  from public, anon, authenticated;
revoke all on function recompute_cleaner_rating(uuid) from public, anon, authenticated;

grant execute on function record_application(text, text, text, text, numeric, boolean, boolean,
                                             text[], cleaner_type, boolean, text, jsonb, text)
  to service_role;
grant execute on function advance_application(uuid, application_status, text, uuid, numeric, text)
  to service_role;
grant execute on function activate_cleaner(uuid, cleaner_type, uuid, integer, numeric)
  to service_role;
grant execute on function recompute_cleaner_rating(uuid) to service_role;
grant execute on function provisional_cleaner_rating(), rating_prior_weight() to service_role;
