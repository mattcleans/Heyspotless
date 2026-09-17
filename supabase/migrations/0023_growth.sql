-- ============================================================================
-- 0023 — the leak, and the two numbers nobody can currently see
--
-- Phase 07. The build plan puts lead conversion at the top of the table of
-- levers: marketing running at ~33% of revenue against a 15% target is worth
-- about $24,000 a year, which is more than the Housecall Pro subscription, the
-- route-density saving and the phone-hours saving COMBINED. It is also the one
-- lever with nothing built behind it — `leads` has existed since 0001 with
-- nothing ever inserting a row.
--
-- WHAT LOSES A LEAD. Not price. Time. A homeowner who fills in a form on a
-- Saturday afternoon and hears nothing until Monday has, by Monday, booked
-- somebody else. So the widget prices the job on the spot from the same
-- function the office uses, the lead is written down with that price on it, and
-- the chase is a queue rather than somebody's memory.
--
-- WHAT THIS MIGRATION IS NOT. It is not a CRM. There is no pipeline stage, no
-- owner, no activity feed. A lead has a status, a price, and a record of when
-- somebody first answered it, because that last one is the KPI the whole phase
-- exists to move.
--
-- The two views at the bottom are the other half: job costing (what a clean
-- actually earned after the labour and the driving) and churn risk (a recurring
-- customer who has quietly stopped booking). Both are things Housecall Pro
-- famously does not do, and both are reads over data that is already here.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 23 $$;

-- ---------------------------------------------------------------- leads -----
/**
 * What the widget knows when somebody presses the button.
 *
 * `stated_size` has been on this table since 0001 as free text, and free text
 * is what it should stay: it is what the customer SAID. These columns are what
 * the pricing engine was given, which is a different thing and the one that has
 * to be reproducible — a quote that cannot be recomputed from its own inputs is
 * a number nobody can defend three weeks later.
 */
alter table leads
  add column service_type   text,
  add column bedrooms       integer,
  add column bathrooms      integer,
  add column half_baths     integer not null default 0,
  add column zip            text,
  /** What the widget showed them. Not a promise — the size is unverified. */
  add column quoted_price_cents integer,
  add column estimated_minutes  integer,
  /**
   * A2P requires express written consent before texting a number somebody
   * typed into a web form, and the evidence is the timestamp, exactly as it is
   * for autopay in 0006. No timestamp, no nudges — the sequence checks this
   * column and not a checkbox somebody remembers ticking.
   */
  add column sms_consent_at timestamptz,
  add column sms_consent_text text,
  /** Where it came from, past the coarse `source` enum: utm, page, referrer. */
  add column attribution jsonb;

comment on column leads.quoted_price_cents is
  'What the booking widget showed, from buildQuote() on unverified room counts. '
  'The office re-prices against the real property before anything is booked.';

comment on column leads.first_response_at is
  'When a person first answered. TIME TO FIRST RESPONSE IS THE KPI OF PHASE 07 '
  '-- see docs/build-plan.md. Set by mark_lead_responded, never by hand.';

-- The inbox's working set: unanswered, oldest first. An unanswered lead from
-- Saturday is the one that matters on Monday, not the newest one.
create index leads_unanswered on leads (received_at)
  where first_response_at is null and status in ('new', 'quoted');

/**
 * Write down an enquiry.
 *
 * SECURITY DEFINER and service-role only, because the caller is an anonymous
 * request from a public form. Letting the browser insert into `leads` directly
 * would mean letting it choose `status`, `customer_id` and `first_response_at`
 * — which is a way to mark somebody else's lead as answered.
 *
 * Nothing here is deduplicated. Two enquiries from one person in ten minutes
 * are two enquiries; the office can see that faster than a rule can guess it,
 * and a form that silently does nothing the second time is a form somebody
 * refreshes and gives up on.
 */
create or replace function record_lead(
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_phone      text,
  p_raw_address text,
  p_zip        text,
  p_service    text,
  p_service_type text,
  p_freq       frequency,
  p_bedrooms   integer,
  p_bathrooms  integer,
  p_half_baths integer,
  p_quoted_price_cents integer,
  p_estimated_minutes  integer,
  p_message    text default null,
  p_sms_consent_text text default null,
  p_attribution jsonb default null,
  p_source     lead_source default 'website'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into leads (
    source, status, first_name, last_name, email, phone, raw_address, zip,
    service, service_type, freq, bedrooms, bathrooms, half_baths,
    quoted_price_cents, estimated_minutes, message,
    sms_consent_at, sms_consent_text, attribution
  ) values (
    p_source, 'new', p_first_name, p_last_name, p_email, p_phone, p_raw_address, p_zip,
    p_service, p_service_type, p_freq,
    greatest(0, coalesce(p_bedrooms, 0)),
    greatest(0, coalesce(p_bathrooms, 0)),
    greatest(0, coalesce(p_half_baths, 0)),
    p_quoted_price_cents, p_estimated_minutes, p_message,
    -- Consent exists only if the form actually presented the language. A null
    -- here is what stops the nudge sequence texting somebody who never agreed.
    case when p_sms_consent_text is not null and p_phone is not null then now() end,
    p_sms_consent_text,
    p_attribution
  )
  returning id into v_id;

  return v_id;
end $$;

/**
 * Somebody answered.
 *
 * Idempotent on purpose: FIRST response, not latest. The second reply to a
 * conversation must not keep resetting the clock the whole phase is measured
 * on. Returns true only when this call was the one that set it, so the caller
 * can tell a first answer from a continuation.
 */
create or replace function mark_lead_responded(p_lead_id uuid, p_at timestamptz default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update leads set first_response_at = coalesce(p_at, now())
   where id = p_lead_id and first_response_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

/**
 * Stop chasing.
 *
 * A lead that is won, lost or spam has no business in the nudge queue, and the
 * queue is the thing that would otherwise text somebody who booked yesterday.
 * Cancelling the automations is part of setting the status rather than a second
 * thing to remember.
 */
create or replace function set_lead_status(p_lead_id uuid, p_status lead_status)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update leads set status = p_status where id = p_lead_id;

  if p_status in ('won', 'lost', 'spam') then
    -- Unfired and unleased only. What has already gone out has gone out.
    update automations
       set fired_at = now(), outcome = 'canceled', error = 'lead ' || p_status
     where subject_type = 'lead' and subject_id = p_lead_id
       and fired_at is null and lease_owner is null;
  end if;
end $$;

-- ------------------------------------------------------------ job costing --
/**
 * What a clean actually earned.
 *
 * THE THING HOUSECALL PRO DOES NOT DO. Revenue minus the labour that was really
 * spent minus the driving to get there, per job — not per month, not per
 * customer, per JOB. The build plan's entire dispatch argument rests on numbers
 * of this shape, and until now they existed only in the plan's own tables.
 *
 * A VIEW RATHER THAN A TABLE, deliberately. Every input already lives
 * somewhere: the ticket on `jobs`, the payout on `job_assignments`, the real
 * hours on `time_entries`. A costing table would be a fourth copy that goes
 * stale the first time a time entry is corrected.
 *
 * W-2 AND CONTRACTOR COST DIFFERENT THINGS, which is the point of the whole
 * engine, so they are computed differently here too:
 *
 *   * A CONTRACTOR costs her payout. The drive is hers — that is the durable
 *     edge the plan identifies, a contractor paid a flat percentage absorbs
 *     her own windshield time.
 *   * A W-2 costs hours times rate times burden, INCLUDING the drive, because
 *     under the FLSA that time is owed. Overtime is not modelled here: this is
 *     a per-job view and overtime is a property of the week, so the honest
 *     answer at this altitude is base cost, and the overtime forecast stays on
 *     the dispatch board where the week is visible.
 */
create or replace view job_costing
with (security_invoker = true) as
select
  j.id                        as job_id,
  j.customer_id,
  j.scheduled_start,
  j.completed_at,
  j.service,
  j.freq,
  j.price_cents               as revenue_cents,
  ja.cleaner_id,
  c.full_name                 as cleaner_name,
  c.type                      as cleaner_type,
  j.estimated_clean_minutes,
  te.clean_minutes,
  te.drive_minutes,
  te.drive_miles,
  case
    when c.type = 'contractor_1099' then coalesce(ja.payout_cents, 0)
    else round(
      -- Paid minutes: the clean, plus the drive where it is on the clock.
      (coalesce(te.clean_minutes, j.estimated_clean_minutes)
        + case when coalesce(c.drive_time_paid, true) then coalesce(te.drive_minutes, 0) else 0 end
      )::numeric / 60
      * coalesce(c.hourly_rate_cents, 0)
      * (1 + coalesce(c.employer_burden_rate, 0.15))
    )::integer
  end                         as labour_cost_cents,
  case
    -- Mileage is reimbursed only where the cleaner uses her own vehicle. The
    -- company truck is a fixed cost and belongs nowhere near a per-job number.
    when coalesce(c.uses_company_vehicle, false) then 0
    when c.type = 'contractor_1099' then 0
    else round(coalesce(te.drive_miles, 0) * coalesce(m.cents_per_mile, 0))::integer
  end                         as mileage_cost_cents
from jobs j
left join job_assignments ja on ja.job_id = j.id and ja.is_lead
left join cleaners c on c.id = ja.cleaner_id
left join time_entries te on te.job_id = j.id and te.cleaner_id = ja.cleaner_id
left join lateral (
  select cents_per_mile from mileage_rates
   where effective_from <= coalesce(j.completed_at, j.scheduled_start, now())
   order by effective_from desc limit 1
) m on true;

comment on view job_costing is
  'Revenue minus real labour minus mileage, per job. Overtime is deliberately '
  'absent: it is a property of the week, not the job. See 0023.';

/** The same view with the arithmetic done, because every caller wants it. */
create or replace view job_margins
with (security_invoker = true) as
select jc.*,
       (coalesce(jc.labour_cost_cents, 0) + coalesce(jc.mileage_cost_cents, 0)) as cost_cents,
       jc.revenue_cents
         - coalesce(jc.labour_cost_cents, 0)
         - coalesce(jc.mileage_cost_cents, 0)                                   as margin_cents,
       case when jc.revenue_cents > 0 then
         round((jc.revenue_cents - coalesce(jc.labour_cost_cents, 0)
                                 - coalesce(jc.mileage_cost_cents, 0))::numeric
               / jc.revenue_cents, 4)
       end                                                                      as margin_fraction,
       /** Estimate versus reality. Persistently positive means we under-quote time. */
       case when jc.clean_minutes is not null
            then jc.clean_minutes - jc.estimated_clean_minutes end              as minutes_over_estimate
from job_costing jc;

-- ------------------------------------------------------------- at risk -----
/**
 * A recurring customer who has quietly stopped.
 *
 * CHURN IN THIS BUSINESS IS SILENT. Nobody cancels a cleaning service; they
 * skip one, then skip another, and six weeks later they have a different
 * cleaner. By the time somebody notices, the relationship is gone and the
 * conversation that would have saved it — "is everything all right, we noticed
 * you have not booked" — is three weeks too late to be anything but awkward.
 *
 * So: days since the last completed clean, against the cadence they agreed to.
 * A weekly customer at 20 days has missed two. That is the whole model, and it
 * is deliberately arithmetic rather than a score — a churn model nobody can
 * explain is one nobody acts on.
 *
 * `customers.churn_risk_score` stays where it is for now. This view is what
 * should populate it; writing it from here would mean a view with a side
 * effect, which is a worse idea than a nightly sweep reading this.
 */
create or replace view customer_at_risk
with (security_invoker = true) as
with last_clean as (
  select j.customer_id,
         max(j.completed_at) as last_completed_at,
         count(*) filter (where j.completed_at is not null) as completed_cleans
    from jobs j
   group by j.customer_id
),
next_booked as (
  select j.customer_id, min(j.scheduled_start) as next_start
    from jobs j
   where j.status in ('scheduled', 'assigned', 'dispatching')
     and j.scheduled_start > now()
   group by j.customer_id
),
cadence as (
  select rp.customer_id,
         min(case rp.freq when 'weekly' then 7 when 'biweekly' then 14
                          when 'monthly' then 30 else null end) as expected_days
    from recurring_plans rp
   where rp.active
   group by rp.customer_id
)
select
  cu.id                                   as customer_id,
  cu.first_name,
  cu.last_name,
  cu.lifetime_value_cents,
  lc.last_completed_at,
  lc.completed_cleans,
  nb.next_start                           as next_booked_at,
  cd.expected_days,
  case when lc.last_completed_at is not null
       then (extract(epoch from now() - lc.last_completed_at) / 86400)::integer end
                                          as days_since_last,
  /**
   * Overdue only means something against an agreed cadence, and only when
   * nothing is on the calendar. A customer with a visit booked for Thursday is
   * not at risk however long ago the last one was.
   */
  case
    when nb.next_start is not null then false
    when cd.expected_days is null then false
    when lc.last_completed_at is null then false
    else (extract(epoch from now() - lc.last_completed_at) / 86400) > cd.expected_days * 1.5
  end                                     as at_risk,
  case
    when cd.expected_days is null or lc.last_completed_at is null then null
    else round(((extract(epoch from now() - lc.last_completed_at) / 86400)
                / cd.expected_days)::numeric, 2)
  end                                     as cadences_missed
from customers cu
left join last_clean lc on lc.customer_id = cu.id
left join next_booked nb on nb.customer_id = cu.id
left join cadence cd on cd.customer_id = cu.id;

comment on view customer_at_risk is
  'Days since the last completed clean against the cadence the customer agreed '
  'to, with anything already on the calendar excluded. Arithmetic rather than a '
  'score, because a churn number nobody can explain is one nobody acts on.';

-- ------------------------------------------------------- row level security
/**
 * TWO LOCKS ON THE VIEWS, because one of them can be undone by accident.
 *
 * A view in Postgres runs with the privileges of its OWNER unless it says
 * otherwise. Left at the default, row-level security on `jobs` would not
 * protect `job_costing` at all — and costing is every cleaner's pay and every
 * customer's margin in one place.
 *
 * So, first: `security_invoker = true` on all three, which makes them read the
 * base tables as whoever is asking and puts the `0003` policies back in the
 * path. A cleaner reading `job_costing` sees the jobs she was assigned and
 * nothing else; a customer sees their own.
 *
 * And second, the grant: client roles are not given SELECT at all, so the
 * ordinary answer to a browser session is a permission error rather than an
 * empty set.
 *
 * WHY BOTH, AND WHY THIS ORDER. The grant is the stronger lock and the easier
 * one to lose: Supabase's own defaults grant broadly on `public`, and one
 * `grant all on all tables` by a future migration or a console session silently
 * hands these back. `security_invoker` survives that, which is exactly why the
 * verification suite runs its client-role checks AFTER a deliberate blanket
 * grant — it is asserting the lock that cannot be revoked by accident.
 */
revoke all on job_costing, job_margins, customer_at_risk from public, anon, authenticated;
grant select on job_costing, job_margins, customer_at_risk to service_role;

revoke all on function record_lead(text, text, text, text, text, text, text, text, frequency,
                                   integer, integer, integer, integer, integer, text, text,
                                   jsonb, lead_source)
  from public, anon, authenticated;
revoke all on function mark_lead_responded(uuid, timestamptz) from public, anon, authenticated;
revoke all on function set_lead_status(uuid, lead_status) from public, anon, authenticated;

grant execute on function record_lead(text, text, text, text, text, text, text, text, frequency,
                                      integer, integer, integer, integer, integer, text, text,
                                      jsonb, lead_source)
  to service_role;
grant execute on function mark_lead_responded(uuid, timestamptz) to service_role;
grant execute on function set_lead_status(uuid, lead_status) to service_role;
