-- ============================================================================
-- 0001 — foundation schema
--
-- Data model per section 06 of the Spotless Ops build plan. Conventions, all
-- of which 0002_price_book.sql depends on:
--   * money is integer CENTS everywhere, never float
--   * uuid primary keys via uuid_generate_v4()
--   * the `frequency` enum is defined here; `service_type` is defined in 0002
--   * timestamps are timestamptz, defaulted, never nullable
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------- enums ----
create type frequency        as enum ('one_time', 'monthly', 'biweekly', 'weekly');
create type user_role        as enum ('admin', 'cleaner', 'customer');
create type cleaner_type     as enum ('w2_core', 'contractor_1099');
create type cleaner_status   as enum ('applicant', 'onboarding', 'active', 'paused', 'terminated');
create type job_status       as enum ('unscheduled', 'scheduled', 'dispatching', 'assigned',
                                      'in_progress', 'complete', 'canceled');
create type quote_status     as enum ('draft', 'sent', 'approved', 'declined', 'expired');
create type invoice_status   as enum ('draft', 'sent', 'paid', 'overdue', 'void');
create type offer_status     as enum ('sent', 'accepted', 'declined', 'expired', 'withdrawn');
create type dispatch_channel as enum ('open_board', 'waterfall', 'direct_assign');
create type lead_source      as enum ('website', 'yelp', 'thumbtack', 'phone', 'referral', 'other');
create type lead_status      as enum ('new', 'quoted', 'won', 'lost', 'spam');
create type message_channel  as enum ('sms', 'email', 'in_app');
create type application_status as enum ('submitted', 'screened', 'background_pending',
                                        'background_cleared', 'rejected', 'activated');

-- --------------------------------------------------------- profiles -------
-- Mirrors auth.users. Role lives here because RLS policies join against it.
create table profiles (
  id          uuid primary key,
  role        user_role not null,
  full_name   text not null,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------- customers/properties --
create table customers (
  id                 uuid primary key default uuid_generate_v4(),
  profile_id         uuid references profiles(id) on delete set null,
  first_name         text not null,
  last_name          text not null,
  email              text,
  phone              text,
  first_contact_date date,
  -- Denormalised for the at-risk detector; recomputed, never hand-edited.
  lifetime_value_cents integer not null default 0,
  churn_risk_score     numeric(4,3),
  hcp_customer_id      text unique,   -- provenance through the parallel run
  notes              text,
  created_at         timestamptz not null default now()
);

create table properties (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   uuid not null references customers(id) on delete cascade,
  street        text not null,
  city          text not null,
  state         text not null default 'TX',
  zip           text not null,
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  bedrooms      integer not null default 0,
  bathrooms     integer not null default 0,
  half_baths    integer not null default 0,
  kitchens      integer not null default 1,
  living_rooms  integer not null default 1,
  utility_rooms integer not null default 1,
  square_feet   integer,
  -- Everything the cleaner needs on arrival and nobody remembers to ask.
  gate_code     text,
  access_notes  text,
  parking_notes text,
  pets          text,
  supply_location text,
  size_verified_source text,   -- 'zillow' | 'customer' | 'onsite'
  created_at    timestamptz not null default now()
);
create index on properties (customer_id);
create index on properties (zip);

-- ------------------------------------------------------------ cleaners ----
create table cleaners (
  id             uuid primary key default uuid_generate_v4(),
  profile_id     uuid references profiles(id) on delete set null,
  full_name      text not null,
  type           cleaner_type not null,
  status         cleaner_status not null default 'applicant',

  -- Dispatch eligibility. Enforced in the database (0003), not the UI.
  rating              numeric(3,2),
  acceptance_rate     numeric(4,3),
  reliability_score   numeric(4,3),
  background_check_cleared boolean not null default false,
  insurance_expires_on     date,
  service_zips        text[] not null default '{}',

  -- W-2 terms. guaranteed_hours drives "spend the sunk cost first" (plan 04).
  hourly_rate_cents        integer,
  guaranteed_hours_per_week numeric(5,2),
  overtime_multiplier      numeric(4,2) not null default 1.5,
  employer_burden_rate     numeric(4,3) not null default 0.15,
  uses_company_vehicle     boolean not null default false,
  drive_time_paid          boolean not null default true,

  -- 1099 terms
  default_payout_rate      numeric(4,3),

  created_at     timestamptz not null default now()
);
create index on cleaners (status, type);

create table cleaner_availability (
  id          uuid primary key default uuid_generate_v4(),
  cleaner_id  uuid not null references cleaners(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  starts_at   time not null,
  ends_at     time not null,
  check (ends_at > starts_at)
);
create index on cleaner_availability (cleaner_id);

-- --------------------------------------------------- price book (0002) ----
-- Superseded wholesale by 0002_price_book.sql, which drops this table. It
-- exists here only so 0002's `drop table if exists frequency_multipliers`
-- has something to drop and the migration chain replays cleanly from zero.
create table frequency_multipliers (
  freq       frequency primary key,
  multiplier numeric(4,3) not null
);

-- ------------------------------------------------- quotes / jobs / plans --
create table recurring_plans (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   uuid not null references customers(id) on delete cascade,
  property_id   uuid not null references properties(id) on delete cascade,
  freq          frequency not null,
  service       text not null,             -- widened to service_type in 0002
  -- The agreed price, stored ON THE PLAN. This is the fix for the live
  -- overbilling bug in plan section 09: a recurring customer's rate can never
  -- be silently re-derived from the current price book.
  agreed_price_cents integer not null,
  estimated_minutes  integer not null default 0,
  next_job_date   date,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on recurring_plans (customer_id) where active;

create table quotes (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   uuid not null references customers(id) on delete cascade,
  property_id   uuid not null references properties(id) on delete cascade,
  service       text not null,
  freq          frequency not null,
  status        quote_status not null default 'draft',
  subtotal_cents integer not null default 0,
  total_cents    integer not null default 0,
  estimated_minutes integer not null default 0,
  expires_on    date,                       -- expiry creates real urgency
  sent_at       timestamptz,
  responded_at  timestamptz,
  notes         text,
  created_at    timestamptz not null default now()
);
create index on quotes (status, created_at desc);

create table quote_line_items (
  id           uuid primary key default uuid_generate_v4(),
  quote_id     uuid not null references quotes(id) on delete cascade,
  item_key     text not null,
  name         text not null,
  quantity     integer not null default 1,
  unit_price_cents integer not null,
  total_cents      integer not null,
  clean_minutes    integer not null default 0,
  sort_order   integer not null default 0
);
create index on quote_line_items (quote_id);

create table jobs (
  id                uuid primary key default uuid_generate_v4(),
  customer_id       uuid not null references customers(id) on delete cascade,
  property_id       uuid not null references properties(id) on delete cascade,
  quote_id          uuid references quotes(id) on delete set null,
  recurring_plan_id uuid references recurring_plans(id) on delete set null,
  status            job_status not null default 'unscheduled',
  service           text not null,
  freq              frequency not null,
  scheduled_start   timestamptz,
  scheduled_end     timestamptz,
  price_cents       integer not null,
  estimated_clean_minutes integer not null,
  -- Set when dispatch resolves. Null while the job is on the board.
  dispatch_channel  dispatch_channel,
  hcp_job_id        text unique,
  notes             text,
  created_at        timestamptz not null default now()
);
create index on jobs (status, scheduled_start);
create index on jobs (scheduled_start) where status in ('scheduled', 'assigned');

-- ------------------------------------------------------------- offers -----
-- The auction ledger. Every offer ever made — this table is how the business
-- learns what the market rate actually is (plan section 06).
create table offers (
  id            uuid primary key default uuid_generate_v4(),
  job_id        uuid not null references jobs(id) on delete cascade,
  cleaner_id    uuid not null references cleaners(id) on delete cascade,
  channel       dispatch_channel not null,
  tier          integer not null default 1,
  -- Denominated in $/hour, NOT % of price (plan section 04). The percentage
  -- floats per job; the cleaner's take-home per hour is what stays flat.
  hourly_rate_cents integer not null,
  payout_cents      integer not null,
  payout_pct        numeric(5,4) not null,
  estimated_minutes integer not null,
  status        offer_status not null default 'sent',
  sent_at       timestamptz not null default now(),
  expires_at    timestamptz not null,
  responded_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on offers (job_id, sent_at);
create index on offers (cleaner_id, status);

create table job_assignments (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs(id) on delete cascade,
  cleaner_id  uuid not null references cleaners(id) on delete cascade,
  offer_id    uuid references offers(id) on delete set null,
  is_lead     boolean not null default true,
  payout_cents integer not null default 0,
  assigned_at timestamptz not null default now(),
  unique (job_id, cleaner_id)
);
create index on job_assignments (cleaner_id);

create table time_entries (
  id            uuid primary key default uuid_generate_v4(),
  job_id        uuid not null references jobs(id) on delete cascade,
  cleaner_id    uuid not null references cleaners(id) on delete cascade,
  clock_in_at   timestamptz not null,
  clock_out_at  timestamptz,
  clock_in_lat  numeric(9,6),
  clock_in_lng  numeric(9,6),
  -- Split out because drive time is paid but not billable, and the gap
  -- between the two is worth ~$5.9k/yr (plan section 05).
  clean_minutes integer,
  drive_minutes integer,
  drive_miles   numeric(6,2)
);
create index on time_entries (job_id);
create index on time_entries (cleaner_id, clock_in_at desc);

-- ------------------------------------------- checklists / photos / ratings -
create table checklists (
  id        uuid primary key default uuid_generate_v4(),
  job_id    uuid not null references jobs(id) on delete cascade,
  room_key  text not null,
  task      text not null,
  done      boolean not null default false,
  done_at   timestamptz,
  sort_order integer not null default 0
);
create index on checklists (job_id);

create table job_photos (
  id           uuid primary key default uuid_generate_v4(),
  job_id       uuid not null references jobs(id) on delete cascade,
  cleaner_id   uuid references cleaners(id) on delete set null,
  storage_path text not null,          -- Supabase Storage
  kind         text not null,          -- 'before' | 'after' | 'issue'
  room_key     text,
  taken_at     timestamptz not null default now()
);
create index on job_photos (job_id);

create table ratings (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs(id) on delete cascade,
  cleaner_id  uuid not null references cleaners(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  score       numeric(3,2) not null check (score >= 1 and score <= 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (job_id, customer_id)
);
create index on ratings (cleaner_id);

-- ------------------------------------------------------------- money ------
create table invoices (
  id            uuid primary key default uuid_generate_v4(),
  job_id        uuid references jobs(id) on delete set null,
  customer_id   uuid not null references customers(id) on delete cascade,
  status        invoice_status not null default 'draft',
  subtotal_cents integer not null default 0,
  tip_cents      integer not null default 0,
  total_cents    integer not null default 0,
  amount_paid_cents integer not null default 0,
  due_on        date,
  stripe_invoice_id text unique,
  hcp_invoice_id    text unique,
  created_at    timestamptz not null default now()
);
create index on invoices (status, due_on);

create table payments (
  id            uuid primary key default uuid_generate_v4(),
  invoice_id    uuid not null references invoices(id) on delete cascade,
  amount_cents  integer not null,
  -- Stripe objects mirrored locally so reporting never depends on an API call.
  stripe_payment_intent_id text unique,
  method        text,
  succeeded_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on payments (invoice_id);

create table payouts (
  id            uuid primary key default uuid_generate_v4(),
  cleaner_id    uuid not null references cleaners(id) on delete cascade,
  job_id        uuid references jobs(id) on delete set null,
  amount_cents  integer not null,
  mileage_cents integer not null default 0,
  period_start  date,
  period_end    date,
  paid_at       timestamptz,
  stripe_transfer_id text unique,
  created_at    timestamptz not null default now()
);
create index on payouts (cleaner_id, period_start);

-- -------------------------------------------- leads / messages / automation
create table leads (
  id           uuid primary key default uuid_generate_v4(),
  source       lead_source not null,
  status       lead_status not null default 'new',
  first_name   text,
  last_name    text,
  email        text,
  phone        text,
  raw_address  text,
  service      text,
  freq         frequency,
  stated_size  text,
  message      text,
  customer_id  uuid references customers(id) on delete set null,
  quote_id     uuid references quotes(id) on delete set null,
  received_at  timestamptz not null default now(),
  first_response_at timestamptz,     -- time-to-first-response is the KPI
  created_at   timestamptz not null default now()
);
create index on leads (status, received_at desc);
create index on leads (source, received_at desc);

create table messages (
  id           uuid primary key default uuid_generate_v4(),
  channel      message_channel not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  customer_id  uuid references customers(id) on delete cascade,
  cleaner_id   uuid references cleaners(id) on delete cascade,
  lead_id      uuid references leads(id) on delete cascade,
  job_id       uuid references jobs(id) on delete cascade,
  body         text not null,
  to_address   text,
  from_address text,
  provider_id  text,                 -- Twilio SID / email message-id
  sent_at      timestamptz not null default now(),
  read_at      timestamptz
);
create index on messages (customer_id, sent_at desc);
create index on messages (lead_id, sent_at desc);

create table automations (
  id           uuid primary key default uuid_generate_v4(),
  trigger_key  text not null,        -- 'lead.created' | 'job.completed' | ...
  action_key   text not null,        -- 'sms.nudge' | 'invoice.autocharge' | ...
  subject_type text not null,
  subject_id   uuid,
  scheduled_for timestamptz,
  fired_at     timestamptz,
  outcome      text,
  error        text,
  created_at   timestamptz not null default now()
);
create index on automations (scheduled_for) where fired_at is null;

-- -------------------------------------------------------- applications ----
-- The recruiting funnel. Nobody reaches `cleaners` without clearing it.
create table applications (
  id            uuid primary key default uuid_generate_v4(),
  first_name    text not null,
  last_name     text not null,
  email         text,
  phone         text,
  status        application_status not null default 'submitted',
  screen_score  numeric(5,2),
  screen_notes  text,
  has_vehicle   boolean,
  work_authorized boolean,
  years_experience numeric(4,1),
  background_check_ref text,
  cleaner_id    uuid references cleaners(id) on delete set null,
  submitted_at  timestamptz not null default now()
);
create index on applications (status, submitted_at desc);
