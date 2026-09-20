-- ============================================================================
-- 0028 — the client app
--
-- The seven-screen customer journey: book a clean, meet the cleaner we matched
-- you with, watch the visit progress, rate and tip when it sparkles.
--
-- THREE DECISIONS SETTLED BEFORE ANY OF THIS WAS WRITTEN, because each one
-- changes what the schema has to hold.
--
-- 1. THE ENGINE STILL ROUTES. The design showed a browse-and-pick list of
--    cleaners with a rate on each. That is a different business — it bypasses
--    the marginal-cost ceiling, the tier ordering and the exclusive incumbent
--    hold, and it makes the cleaner a price-setter. The decision was to keep
--    the routing as built, so there is no "pick your cleaner" here and no
--    per-cleaner rate anywhere in this migration. What a customer sees is the
--    cleaner the engine matched to their clean, and who else serves their area.
--
-- 2. TRACKING IS THE STAGE, NOT THE PERSON. "Live cleaner location on a map"
--    was the other design element that did not survive: continuous position
--    tracking of a 1099 contractor is close to the centre of what worker
--    classification turns on (setup.md §9), and `0020` already refused to store
--    a completion coordinate for the same reason. So the customer sees the
--    stage she is at, the rooms done, and an ETA — all of which this system
--    already knows from `jobs`, `time_entries` and `checklists`, and none of
--    which is a coordinate.
--
-- 3. A TIP IS HERS. It reaches the cleaner less the card processing fee on the
--    tip itself, and nothing else — see `lib/billing/tips.ts` for why that is
--    the percentage only and not a share of the fixed per-transaction fee.
--    Until now a tip was folded into the invoice total and there was no payout
--    path for it at all, which means it was revenue. That was the gap.
-- ============================================================================

-- 0028 rather than 0027: the price-book addition that landed while this was
-- being written already took that number, and two migrations sharing one is a
-- version nobody can act on.
create or replace function app_schema_version() returns integer
language sql immutable as $$ select 28 $$;

-- --------------------------------------------------------- the profile -----
/**
 * Who a cleaner is, as a customer meets her.
 *
 * WRITTEN BY HER, DURING ONBOARDING. The bio is hers — the design's own note
 * says so — and the difference between a bio somebody wrote about themselves
 * and one the office wrote about them is audible in one sentence. `0024` is
 * where the application lands; this is where what she says about herself does.
 */
alter table cleaners
  add column bio text,
  /** Supabase Storage path. Never a URL — the bucket may move. */
  add column photo_path text,
  /** Keys from SPECIALTIES in lib/cleaners/profile.ts, not free text. */
  add column specialties text[] not null default '{}',
  add column languages text[] not null default '{}',
  /**
   * When she started, for "3 yrs with us". Distinct from `created_at`, which is
   * when the row was written — and for anybody carried across from Housecall
   * Pro those are years apart.
   */
  add column hired_on date,
  /**
   * Off by default. A cleaner appears to customers when she has a bio and has
   * agreed to be shown, not merely because she was activated.
   */
  add column profile_published boolean not null default false;

comment on column cleaners.bio is
  'Written by the cleaner during onboarding, in her own words. See 0028.';

/**
 * Everything the client app may show about a cleaner, and nothing else.
 *
 * WHY A VIEW AND NOT A POLICY ON `cleaners`. Row-level security is row-level:
 * a policy letting a customer read the cleaner assigned to their job would hand
 * them her hourly rate, her payout share, her insurance expiry and her profile
 * id along with her name. There is no column-level RLS to reach for. So the
 * safe columns are enumerated once, here, and the base table stays shut.
 *
 * `security_invoker` is deliberately OFF. The view's own WHERE clause is the
 * authorisation: an active cleaner who has published a profile is a cleaner who
 * has agreed to be seen by customers. That is the whole rule, and it is visible
 * in one place rather than spread across policies.
 *
 * The rating is passed through raw. `lib/cleaners/profile.ts` decides whether
 * it is old enough to be shown — a new cleaner sits at the 4.2 prior from
 * `0024`, and printing that as a rating would present an assumption as a
 * measurement.
 */
create or replace view cleaner_profiles as
select
  c.id,
  c.full_name,
  c.bio,
  c.photo_path,
  c.specialties,
  c.languages,
  c.hired_on,
  c.service_zips,
  c.rating,
  (select count(*) from ratings r where r.cleaner_id = c.id)              as rating_count,
  (select count(*) from job_assignments ja
     join jobs j on j.id = ja.job_id
    where ja.cleaner_id = c.id and j.status = 'complete')                 as completed_cleans,
  -- Every cleaner here has cleared it; 0024 makes that a condition of being on
  -- the roster at all. Carried so the badge does not need a second query.
  c.background_check_cleared
from cleaners c
where c.status = 'active' and c.profile_published;

comment on view cleaner_profiles is
  'The only cleaner columns a customer may read. The base table stays shut: a '
  'row policy would expose pay terms alongside the name. See 0028.';

/**
 * The handful of reviews a profile shows.
 *
 * Comments only, with the customer reduced to a first name and an initial —
 * the same rule the cleaner gets, for the same reason. A review with a full
 * name on it is a review somebody can be found by.
 */
create or replace view cleaner_reviews as
select
  r.cleaner_id,
  r.score,
  r.comment,
  r.created_at,
  split_part(cu.first_name, ' ', 1) || ' ' ||
    case when cu.last_name is null or cu.last_name = '' then ''
         else left(cu.last_name, 1) || '.' end                            as reviewer_name
from ratings r
join customers cu on cu.id = r.customer_id
where r.comment is not null and length(trim(r.comment)) > 0;

-- ------------------------------------------------------------- rate & tip --
/**
 * What stood out, and what they would rather say privately.
 *
 * The chips are structured because they are counted — "great with pets" across
 * forty cleans is a specialty she can claim, and free text is not countable.
 * The private note is the opposite: it exists precisely so somebody can say
 * something they would not put in a public review, and it is never shown on a
 * profile.
 */
alter table ratings
  add column highlights text[] not null default '{}',
  add column private_note text;

comment on column ratings.private_note is
  'Seen by the office only, never on a profile. The whole point is that it is '
  'somewhere to say the thing you would not say publicly. See 0028.';

/**
 * Record a rating with everything the client app collects.
 *
 * Supersedes `0024`'s three-argument version, which stays as it is — the SMS
 * link in `0022` still calls it, and a text message collects a score and a
 * sentence, not chips.
 */
create or replace function record_rating_detailed(
  p_job_id       uuid,
  p_score        numeric,
  p_comment      text default null,
  p_highlights   text[] default '{}',
  p_private_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := record_rating(p_job_id, p_score, p_comment);
  if v_id is null then return null; end if;

  update ratings set
    highlights = coalesce(p_highlights, '{}'),
    private_note = p_private_note
  where id = v_id;

  return v_id;
end $$;

-- ----------------------------------------------------------------- tips ----
/**
 * A tip, and the only thing that may come out of it.
 *
 * `payouts` has existed since `0001` for the work. A tip is a different kind of
 * money — it is the customer's gift to a person, passing through a business
 * that is allowed to recover only what the card network charged to carry it —
 * so it is recorded as its own columns rather than added into `amount_cents`,
 * where it would be indistinguishable from earnings and impossible to audit.
 */
alter table payouts
  add column tip_cents integer not null default 0 check (tip_cents >= 0),
  add column tip_fee_cents integer not null default 0 check (tip_fee_cents >= 0),
  add column tip_net_cents integer not null default 0 check (tip_net_cents >= 0);

alter table payouts
  /**
   * THE INVARIANT THAT MAKES THIS AUDITABLE. Every cent of a tip is either the
   * processor's or hers. A row where they do not add up is a row where somebody
   * has to work out by hand where the difference went.
   */
  add constraint payouts_tip_reconciles
    check (tip_net_cents + tip_fee_cents = tip_cents);

create unique index payouts_one_per_job_cleaner on payouts (job_id, cleaner_id)
  where job_id is not null;

/**
 * Pass a tip through to the cleaner who earned it.
 *
 * THE FEE IS COMPUTED HERE AS WELL AS IN TYPESCRIPT, and the two agree because
 * both floor the same percentage — the rounding goes to the cleaner, so where
 * there is a fraction of a cent she keeps it. The duplication is the same
 * bargain the price book makes: money arithmetic that only exists in the
 * application is money arithmetic that a direct SQL write can bypass.
 *
 * Idempotent on (job, cleaner). A customer who edits their tip gets the new
 * figure rather than a second payout — `p_tip_cents` is the tip as it now
 * stands, not a delta.
 */
create or replace function record_tip_payout(
  p_job_id    uuid,
  p_tip_cents integer,
  p_fee_rate  numeric default 0.029
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_cleaner_id uuid;
  v_fee integer;
  v_id uuid;
begin
  if p_tip_cents is null or p_tip_cents < 0 then
    raise exception 'a tip cannot be negative' using errcode = 'check_violation';
  end if;

  -- Whoever actually did it. Without an assignment there is nobody to tip, and
  -- a tip attached to no cleaner is money the business has quietly kept.
  select ja.cleaner_id into v_cleaner_id
    from job_assignments ja
   where ja.job_id = p_job_id
   order by ja.is_lead desc, ja.assigned_at
   limit 1;

  if v_cleaner_id is null then return null; end if;

  -- Floor: the fraction of a cent goes to her. See lib/billing/tips.ts.
  v_fee := floor(p_tip_cents * p_fee_rate);

  insert into payouts (cleaner_id, job_id, amount_cents,
                       tip_cents, tip_fee_cents, tip_net_cents)
  values (v_cleaner_id, p_job_id, 0,
          p_tip_cents, v_fee, p_tip_cents - v_fee)
  on conflict (job_id, cleaner_id) where job_id is not null do update set
    tip_cents = excluded.tip_cents,
    tip_fee_cents = excluded.tip_fee_cents,
    tip_net_cents = excluded.tip_net_cents
  returning id into v_id;

  return v_id;
end $$;

/**
 * Put the tip on the invoice, so the existing collection path carries it.
 *
 * WHY NOT AT PAYMENT TIME. `record_payment` already takes a tip, and that is
 * the right place for one added AT the moment of paying. But the client app
 * asks for the tip on the rate screen, hours before the card is charged and
 * possibly before an autocharge sweep runs — so the tip has to be on the
 * invoice by then, or the sweep collects the balance without it and the
 * cleaner's tip is stranded.
 *
 * Raising the balance is exactly what should happen: the customer said they
 * owe another $20, and every path that collects a balance now collects it.
 *
 * THE SAME CEILING AS `lib/billing/amounts.ts`: a tip may not exceed the work
 * it is thanking. 100% of the subtotal is generous and still catches the
 * fat-finger — a $1,700 tip typed into a $170 clean.
 *
 * Idempotent in the way the screen needs: the tip is SET, not added, so a
 * customer changing their mind from $20 to $25 owes $25 rather than $45.
 */
create or replace function set_invoice_tip(
  p_invoice_id uuid,
  p_tip_cents  integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_subtotal integer;
  v_paid integer;
begin
  if p_tip_cents is null or p_tip_cents < 0 then
    raise exception 'a tip cannot be negative' using errcode = 'check_violation';
  end if;

  select subtotal_cents, amount_paid_cents into v_subtotal, v_paid
    from invoices where id = p_invoice_id for update;

  if v_subtotal is null then return null; end if;

  if p_tip_cents > v_subtotal then
    raise exception 'a tip of % exceeds the % it is thanking', p_tip_cents, v_subtotal
      using errcode = 'check_violation';
  end if;

  update invoices set
    tip_cents = p_tip_cents,
    total_cents = subtotal_cents + p_tip_cents
  where id = p_invoice_id;

  return p_tip_cents;
end $$;

-- ------------------------------------------------------- visit progress ----
/**
 * What the customer sees while somebody is in their house.
 *
 * THE STAGE, NOT THE PERSON — see the header. Everything here is derived from
 * what the job already records, and there is not a coordinate in it.
 *
 * `rooms_done` counts rooms with photographic evidence rather than ticked
 * boxes, because that is what `0020` and `0021` made the completion gate out
 * of: the number the customer watches is the same number that decides whether
 * the job can be invoiced.
 */
create or replace view visit_progress
with (security_invoker = true) as
select
  j.id                        as job_id,
  j.customer_id,
  j.status,
  j.scheduled_start,
  j.started_at,
  j.completed_at,
  j.estimated_clean_minutes,
  ja.cleaner_id,
  case
    when j.status = 'complete'    then 'done'
    when j.started_at is not null then 'cleaning'
    when ja.cleaner_id is not null then 'accepted'
    else 'scheduled'
  end                         as stage,
  (select count(distinct p.room_key) from job_photos p
    where p.job_id = j.id and p.room_key is not null) as rooms_done,
  /**
   * When she is expected to finish: from when she actually started where she
   * has, and from the schedule before that. A number that moves when the day
   * moves is the only honest version.
   */
  coalesce(j.started_at, j.scheduled_start)
    + make_interval(mins => j.estimated_clean_minutes) as expected_finish_at
from jobs j
left join job_assignments ja on ja.job_id = j.id and ja.is_lead;

comment on view visit_progress is
  'Stage, rooms done and an ETA — never a location. See 0028 and setup.md item 9.';

-- ----------------------------------------------------------- her photo ----
/**
 * Somewhere for the headshots to live.
 *
 * PRIVATE, like `job-photos`. A cleaner's face and first name is something to
 * show the customer whose house she is cleaning, not something to publish to
 * the open internet — which is the same reason `anon` is not granted on
 * `cleaner_profiles` below. The app serves these through short-lived signed
 * URLs; see `lib/cleaners/photo.ts`.
 *
 * Paths are `cleaners/<cleaner_id>/<file>`, so the second segment is whose
 * photo it is and that is what the write policy checks. She may replace her
 * own; only the office may put one there for her.
 *
 * GUARDED the same way `0021` is: `storage` is a Supabase schema and the
 * migration verification script replays this chain against a bare PostgreSQL
 * where it does not exist.
 */
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice '0028: no storage schema (local verification) -- skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('cleaner-photos', 'cleaner-photos', false, 5242880,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$
    drop policy if exists cleaner_photos_write_own on storage.objects;
    create policy cleaner_photos_write_own on storage.objects for insert
      with check (
        bucket_id = 'cleaner-photos'
        and (is_admin() or (storage.foldername(name))[2]::uuid = current_cleaner_id())
      );

    drop policy if exists cleaner_photos_update_own on storage.objects;
    create policy cleaner_photos_update_own on storage.objects for update
      using (
        bucket_id = 'cleaner-photos'
        and (is_admin() or (storage.foldername(name))[2]::uuid = current_cleaner_id())
      );

    -- Any signed-in customer may see the face of a cleaner who has published a
    -- profile. That is what publishing one means.
    drop policy if exists cleaner_photos_read on storage.objects;
    create policy cleaner_photos_read on storage.objects for select
      using (bucket_id = 'cleaner-photos' and auth.role() = 'authenticated');
  $p$;
end $$;

-- ------------------------------------------------------- row level security
/**
 * The profile views are readable by any signed-in person, and that is the
 * point of them: every column in them was chosen to be shown to a customer,
 * and a customer has no other way to learn who is coming to their house.
 *
 * `anon` is deliberately NOT granted. A cleaner's face, first name and service
 * area is not something to publish to the open internet — it is something to
 * show the customer whose house she is cleaning.
 */
revoke all on cleaner_profiles, cleaner_reviews from public, anon;
grant select on cleaner_profiles, cleaner_reviews to authenticated, service_role;

-- `visit_progress` is security_invoker, so the 0003 policies on `jobs` decide
-- who sees which row: a customer their own, a cleaner hers, an admin all.
revoke all on visit_progress from public, anon;
grant select on visit_progress to authenticated, service_role;

revoke all on function record_rating_detailed(uuid, numeric, text, text[], text)
  from public, anon, authenticated;
revoke all on function record_tip_payout(uuid, integer, numeric)
  from public, anon, authenticated;
revoke all on function set_invoice_tip(uuid, integer) from public, anon, authenticated;

grant execute on function record_rating_detailed(uuid, numeric, text, text[], text)
  to service_role;
grant execute on function record_tip_payout(uuid, integer, numeric) to service_role;
grant execute on function set_invoice_tip(uuid, integer) to service_role;
