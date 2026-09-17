-- ============================================================================
-- 0025 — bringing the business across
--
-- Phase 09. The deployment has been live and green for a fortnight and the
-- database is empty: every sweep reports `{"jobs":0,...}`, every check passes,
-- and nothing happens. A green sweep against an empty database is the most
-- convincing wrong answer this system can give.
--
-- THE RULE THIS WHOLE MIGRATION EXISTS TO ENFORCE. From the build plan's risk
-- list, and it is not a footnote:
--
--   > The 9 August increase applies to NEW customers only. Migration must carry
--   > old rates across or the first regenerated quote silently raises every
--   > long-standing customer's price.
--
-- A customer who has paid $150 a fortnight for three years must go on paying
-- $150 a fortnight. The price book is not the answer for them — `0014` put the
-- agreed rate on the plan for exactly this reason, and the importer's job is to
-- fill it from what they were actually charged rather than from what the
-- current book says they should be.
--
-- IDEMPOTENCY IS NOT OPTIONAL HERE EITHER. A migration is run, found wanting,
-- fixed and run again — often several times, often against a database somebody
-- is already using. Every import function keys on the Housecall Pro id, which
-- `0001` already made unique on `customers` and `jobs`, so a second run updates
-- what it wrote the first time and creates nothing twice.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not parse a CSV. The parsing lives
-- in `scripts/import-hcp.ts`, where it can be read and corrected without a
-- migration, and where a dry run can print what it WOULD write. This file is
-- the half that has to be transactional and enforceable.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 25 $$;

-- ----------------------------------------------------------- provenance ----
/**
 * One row per run of the importer.
 *
 * The thing this answers, months later, is "where did this customer come from
 * and when" — which matters because Housecall Pro stays the archive of record
 * for a few months and somebody will need to reconcile the two.
 */
create table import_batches (
  id          uuid primary key default uuid_generate_v4(),
  source      text not null default 'housecall_pro',
  kind        text not null,              -- 'customers' | 'jobs' | 'plans'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  dry_run     boolean not null default false,
  created     integer not null default 0,
  updated     integer not null default 0,
  skipped     integer not null default 0,
  failed      integer not null default 0,
  notes       jsonb
);

alter table import_batches enable row level security;
create policy import_batches_admin_all on import_batches for all
  using (is_admin()) with check (is_admin());

/** A property's provenance, which 0001 gave customers and jobs but not properties. */
alter table properties add column hcp_address_id text;
create unique index properties_hcp_address on properties (hcp_address_id)
  where hcp_address_id is not null;

alter table recurring_plans add column hcp_plan_id text;
create unique index recurring_plans_hcp_plan on recurring_plans (hcp_plan_id)
  where hcp_plan_id is not null;

-- -------------------------------------------------------------- customers --
/**
 * A customer, from the export.
 *
 * Keyed on the Housecall Pro id, so running the importer twice updates rather
 * than duplicates. Contact details are overwritten from the export because it
 * is the system of record until the parallel run ends; `notes` is concatenated
 * rather than replaced, because anything typed HERE during the parallel run is
 * newer than the export and must not be thrown away by a re-run.
 */
create or replace function import_customer(
  p_hcp_id     text,
  p_first_name text,
  p_last_name  text,
  p_email      text default null,
  p_phone      text default null,
  p_notes      text default null,
  p_first_contact_date date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into customers (hcp_customer_id, first_name, last_name, email, phone,
                         notes, first_contact_date)
  values (p_hcp_id, p_first_name, coalesce(p_last_name, ''), p_email, p_phone,
          p_notes, p_first_contact_date)
  on conflict (hcp_customer_id) do update set
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    email      = coalesce(excluded.email, customers.email),
    phone      = coalesce(excluded.phone, customers.phone),
    first_contact_date = coalesce(customers.first_contact_date, excluded.first_contact_date),
    notes = case
      when excluded.notes is null then customers.notes
      when customers.notes is null then excluded.notes
      when position(excluded.notes in customers.notes) > 0 then customers.notes
      else customers.notes || E'\n' || excluded.notes
    end
  returning id into v_id;

  return v_id;
end $$;

create or replace function import_property(
  p_hcp_address_id text,
  p_customer_id uuid,
  p_street text,
  p_city   text,
  p_zip    text,
  p_state  text default 'TX',
  p_bedrooms integer default 0,
  p_bathrooms integer default 0,
  p_half_baths integer default 0,
  p_access_notes text default null,
  p_gate_code text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into properties (hcp_address_id, customer_id, street, city, state, zip,
                          bedrooms, bathrooms, half_baths, access_notes, gate_code,
                          size_verified_source)
  values (p_hcp_address_id, p_customer_id, p_street, p_city, p_state, p_zip,
          greatest(0, coalesce(p_bedrooms, 0)),
          greatest(0, coalesce(p_bathrooms, 0)),
          greatest(0, coalesce(p_half_baths, 0)),
          p_access_notes, p_gate_code,
          -- Room counts from an HCP export are whatever somebody typed when the
          -- customer was created, often years ago. Marked unverified so the
          -- quote engine's output is read as an estimate until somebody checks.
          'hcp_import')
  on conflict (hcp_address_id) where hcp_address_id is not null do update set
    street = excluded.street,
    city   = excluded.city,
    zip    = excluded.zip,
    -- Never overwrite a room count somebody has since verified on site.
    bedrooms = case when properties.size_verified_source = 'hcp_import'
                    then excluded.bedrooms else properties.bedrooms end,
    bathrooms = case when properties.size_verified_source = 'hcp_import'
                     then excluded.bathrooms else properties.bathrooms end,
    half_baths = case when properties.size_verified_source = 'hcp_import'
                      then excluded.half_baths else properties.half_baths end,
    access_notes = coalesce(properties.access_notes, excluded.access_notes),
    gate_code    = coalesce(properties.gate_code, excluded.gate_code)
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------------------ jobs ---
/**
 * A job from the export, past or future.
 *
 * WHAT `completed_at` DOES TO THE REST OF THE SYSTEM, and why the importer sets
 * it deliberately rather than as an afterthought: a completed job is what makes
 * a cleaner the incumbent for that property (`0016`), which is what makes
 * continuity work from day one rather than from the first clean this system
 * runs itself. Bringing history across is not archival — it is what stops every
 * existing customer being re-auctioned to a stranger in week one.
 *
 * The automation planner refuses to ask for a review of a job created after it
 * completed (`BACKFILL_GRACE_HOURS`), which is what stops this import texting
 * three hundred people about cleans they had last week.
 */
create or replace function import_job(
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
language plpgsql security definer set search_path = public as $$
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
  returning id into v_id;

  return v_id;
end $$;

/**
 * Who cleaned it, so continuity has something to read.
 *
 * A historical assignment with a payout of zero is honest: what the cleaner was
 * paid then came out of Housecall Pro's payroll, not this system's, and
 * inventing a number would put fiction into `job_costing`. What matters here is
 * the PAIRING — who has been to this house — and that is what is recorded.
 */
create or replace function import_assignment(
  p_job_id uuid,
  p_cleaner_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into job_assignments (job_id, cleaner_id, payout_cents, is_lead)
  values (p_job_id, p_cleaner_id, 0, true)
  on conflict (job_id, cleaner_id) do update set is_lead = true
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------- recurring plans ---
/**
 * A standing arrangement, at THE PRICE THEY ACTUALLY PAY.
 *
 * `p_agreed_price_cents` is not optional and is not derived from the price
 * book, because the price book is exactly what must not be applied to these
 * customers. It comes from what the export says they were last charged.
 *
 * `price_locked` is set on every imported plan without exception. A legacy
 * customer's rate is not a default to be improved on later; it is what they
 * agreed to, and `0014` made the plan the place that holds it.
 */
create or replace function import_recurring_plan(
  p_hcp_plan_id text,
  p_customer_id uuid,
  p_property_id uuid,
  p_freq        frequency,
  p_service     text,
  p_agreed_price_cents integer,
  p_estimated_minutes  integer,
  p_anchor_date date,
  p_active      boolean default true
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_agreed_price_cents is null or p_agreed_price_cents <= 0 then
    raise exception 'a recurring plan cannot be imported without the price the customer pays'
      using errcode = 'check_violation';
  end if;

  insert into recurring_plans (hcp_plan_id, customer_id, property_id, freq, service,
                               agreed_price_cents, estimated_minutes, anchor_date,
                               active, price_locked)
  values (p_hcp_plan_id, p_customer_id, p_property_id, p_freq, p_service::service_type,
          p_agreed_price_cents, coalesce(p_estimated_minutes, 0), p_anchor_date,
          p_active, true)
  on conflict (hcp_plan_id) where hcp_plan_id is not null do update set
    freq = excluded.freq,
    -- Re-running the importer must not "correct" a rate somebody negotiated
    -- here during the parallel run. The locked price wins.
    agreed_price_cents = case when recurring_plans.price_locked
                              then recurring_plans.agreed_price_cents
                              else excluded.agreed_price_cents end,
    anchor_date = coalesce(recurring_plans.anchor_date, excluded.anchor_date),
    active = excluded.active
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------------- the audit ---
/**
 * The overbilling the pricelist already hints at, as a list rather than a worry.
 *
 * `docs/setup.md` item 7 says at least one live monthly client is paying the
 * full one-time rate, that this is happening right now, and that it is more
 * urgent than anything else on that page. It has stayed a sentence because
 * nothing could compute it: the price book is structured data and what
 * customers actually pay was in Housecall Pro.
 *
 * After the import, both are here. This view is every active recurring plan
 * whose agreed price does not match what the book says that frequency costs for
 * that property, with the difference in dollars and a flag for the direction.
 *
 * OVERCHARGED IS THE URGENT HALF and undercharged is not the same kind of
 * problem: one is money owed back to somebody who trusted us, the other is a
 * decision about whether to raise a price. They are deliberately in one list,
 * because the first question about any difference is "is this deliberate?".
 *
 * It does NOT correct anything. Every row here is a conversation with a
 * customer, and a migration that silently re-priced them would be the exact
 * fault it is meant to detect.
 */
/**
 * `quote_price` raises for a pair the book does not sell — Deep at weekly, say.
 * That is right for a quote and wrong for an audit: one unsellable legacy
 * arrangement would make the whole view raise, and the audit would be
 * unreadable because of the exact row it exists to show.
 */
create or replace function quote_price_or_null(
  p_service   service_type,
  p_freq      frequency,
  p_bedrooms  integer,
  p_bathrooms integer,
  p_half_baths integer default 0,
  p_kitchens  integer default 1,
  p_living    integer default 1,
  p_utility   integer default 1
) returns integer
language plpgsql stable as $$
declare v_total integer;
begin
  select total_cents into v_total
    from quote_price(p_service, p_freq, p_bedrooms, p_bathrooms,
                     p_half_baths, p_kitchens, p_living, p_utility);
  return v_total;
exception when others then
  return null;
end $$;

create or replace view recurring_price_audit
with (security_invoker = true) as
select
  rp.id                       as plan_id,
  rp.customer_id,
  cu.first_name,
  cu.last_name,
  rp.freq,
  rp.service,
  rp.agreed_price_cents,
  rp.price_locked,
  qp.book_price               as book_price_cents,
  rp.agreed_price_cents - qp.book_price as difference_cents,
  case
    when qp.book_price is null then null
    when rp.agreed_price_cents > qp.book_price then 'overcharged'
    when rp.agreed_price_cents < qp.book_price then 'undercharged'
    else 'matches'
  end                         as verdict,
  /**
   * The specific shape setup.md names: a recurring customer paying the
   * ONE-TIME rate, which is what happens when the frequency discount was meant
   * to be applied by hand after booking and nobody did.
   */
  (rp.freq <> 'one_time' and qp1.one_time_price is not null
   and rp.agreed_price_cents = qp1.one_time_price) as paying_one_time_rate
from recurring_plans rp
join customers cu on cu.id = rp.customer_id
join properties p on p.id = rp.property_id
left join lateral (
  select quote_price_or_null(rp.service, rp.freq, p.bedrooms, p.bathrooms,
                             p.half_baths, p.kitchens, p.living_rooms, p.utility_rooms)
         as book_price
) qp on true
left join lateral (
  select quote_price_or_null(rp.service, 'one_time', p.bedrooms, p.bathrooms,
                             p.half_baths, p.kitchens, p.living_rooms, p.utility_rooms)
         as one_time_price
) qp1 on true
where rp.active;

comment on view recurring_price_audit is
  'Every active recurring plan whose agreed price differs from the price book. '
  'setup.md item 7 as a list rather than a worry. Corrects nothing -- every row '
  'is a conversation with a customer. See 0025.';

-- ------------------------------------------------------- row level security
revoke all on recurring_price_audit from public, anon, authenticated;
grant execute on function quote_price_or_null(service_type, frequency, integer, integer,
                                              integer, integer, integer, integer)
  to service_role, authenticated;
grant select on recurring_price_audit to service_role;

revoke all on function import_customer(text, text, text, text, text, text, date)
  from public, anon, authenticated;
revoke all on function import_property(text, uuid, text, text, text, text, integer, integer,
                                       integer, text, text) from public, anon, authenticated;
revoke all on function import_job(text, uuid, uuid, text, frequency, integer, integer,
                                  job_status, timestamptz, timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function import_assignment(uuid, uuid) from public, anon, authenticated;
revoke all on function import_recurring_plan(text, uuid, uuid, frequency, text, integer,
                                             integer, date, boolean)
  from public, anon, authenticated;

grant execute on function import_customer(text, text, text, text, text, text, date)
  to service_role;
grant execute on function import_property(text, uuid, text, text, text, text, integer, integer,
                                          integer, text, text) to service_role;
grant execute on function import_job(text, uuid, uuid, text, frequency, integer, integer,
                                     job_status, timestamptz, timestamptz, timestamptz, text)
  to service_role;
grant execute on function import_assignment(uuid, uuid) to service_role;
grant execute on function import_recurring_plan(text, uuid, uuid, frequency, text, integer,
                                                integer, date, boolean) to service_role;
