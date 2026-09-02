-- ============================================================================
-- 0002 — the real price book, from Hey Spotless Pricelist eff. 9 Aug 2026
--
-- CORRECTION to 0001: rates are stored explicitly per (item, frequency), NOT
-- derived from a frequency multiplier. The pricelist's recurring columns have
-- whole-dollar rounding baked in and they do NOT follow a clean multiplier —
-- Standard Bedroom goes $20 -> $17 bi-weekly (0.85, on the nose) but Half Bath
-- goes $11 -> $10 (0.91) because there was nowhere else for the rounding to
-- land. A multiplier would quietly misprice every quote containing a half bath
-- or utility room. So: explicit rates, and `frequency_multipliers` is dropped.
--
-- Source note the pricelist is emphatic about: "The recurring discount is
-- already baked into these columns — do not discount again."
--
-- ADOPTED FROM MATT'S UPLOADED 0002 with three reviewed fixes, each marked
-- inline with "FIX (0002 review)": the mileage rate column type, a dead no-op
-- loop, and quote_price() silently returning a $0 quote for a service and
-- frequency combination that does not exist.
-- ============================================================================

drop table if exists frequency_multipliers;

create type service_type as enum ('standard', 'deep', 'move_in_out');

-- One row per line item per service type. clean_minutes is the duration
-- ESTIMATE — see the calibration note at the bottom; the app corrects these
-- from actual clocked time.
create table price_book_items (
  id             uuid primary key default uuid_generate_v4(),
  service        service_type not null,
  item_key       text not null,
  name           text not null,
  category       text not null,              -- 'arrival' | 'room' | 'extra'
  clean_minutes  integer not null default 0,
  is_countable   boolean not null default true,   -- false for arrival (qty always 1)
  active         boolean not null default true,
  sort_order     integer not null default 0,
  unique (service, item_key)
);

-- The rate matrix. Not every (item, frequency) pair exists — Deep is only
-- offered one-time and monthly, Move In/Out only one-time.
create table price_book_rates (
  item_id      uuid not null references price_book_items(id) on delete cascade,
  freq         frequency not null,
  price_cents  integer not null,
  primary key (item_id, freq)
);

-- Extras are flat, never discounted, and explicitly were NOT part of the
-- 9 Aug +12% increase.
create table price_book_extras (
  id            uuid primary key default uuid_generate_v4(),
  item_key      text unique not null,
  name          text not null,
  price_cents   integer not null,
  unit_label    text not null default 'flat',
  clean_minutes integer not null default 0,
  active        boolean not null default true,
  sort_order    integer not null default 0
);

-- Existing recurring customers keep locked-in pre-increase rates. Without this
-- the first quote regenerated for an old client silently raises their price.
alter table recurring_plans
  add column if not exists price_locked boolean not null default false,
  add column if not exists price_locked_note text;

-- Mileage reimbursement. Stored with effective dates because the IRS changed
-- it mid-2026: 72.5c through Jun 30, 76c from Jul 1 (first midyear change
-- since 2022). A hardcoded rate would silently underpay.
-- FIX (0002 review): cents_per_mile was `integer`, but the H1-2026 IRS rate is
-- 72.5 cents. `72.5::integer` rounds to 73 and silently overpays every mile of
-- the first half of the year. Fractional cents are real here — numeric(5,2).
create table mileage_rates (
  effective_from date primary key,
  cents_per_mile numeric(5,2) not null,
  note           text
);
insert into mileage_rates (effective_from, cents_per_mile, note) values
  ('2026-01-01', 72.5, 'IRS business standard rate, first half 2026'),
  ('2026-07-01', 76,   'IRS midyear increase, effective 1 Jul 2026')
on conflict (effective_from) do nothing;

-- Per-cleaner mileage terms. Iggy: first 20 miles of a commute unreimbursed,
-- all between-job miles reimbursed, commute miles beyond 20 reimbursed.
alter table cleaners
  add column if not exists mileage_reimbursed boolean not null default false,
  add column if not exists commute_free_miles numeric(6,2) not null default 0,
  add column if not exists between_job_miles_reimbursed boolean not null default false;

-- ------------------------------------------------------------- seed -------
do $$
begin
  -- ---------------- STANDARD ----------------
  -- one_time / monthly / bi-weekly / weekly
  insert into price_book_items (service,item_key,name,category,clean_minutes,is_countable,sort_order) values
    ('standard','arrival',    'Arrival (base)',                   'arrival',20,false,1),
    ('standard','bedroom',    'Bedroom',                          'room',   15,true, 2),
    ('standard','bathroom',   'Bathroom',                         'room',   20,true, 3),
    ('standard','half_bath',  'Half Bathroom',                    'room',   10,true, 4),
    ('standard','kitchen',    'Kitchen',                          'room',   25,true, 5),
    ('standard','living',     'Living / Dining / Media / Office', 'room',   15,true, 6),
    ('standard','utility',    'Utility Room',                     'room',    8,true, 7);

  insert into price_book_rates (item_id, freq, price_cents)
  select i.id, r.freq, r.cents
  from price_book_items i
  join (values
    ('arrival',   'one_time'::frequency, 6700), ('arrival',   'monthly'::frequency, 6000),
    ('arrival',   'biweekly'::frequency, 5700), ('arrival',   'weekly'::frequency,  5400),
    ('bedroom',   'one_time'::frequency, 2000), ('bedroom',   'monthly'::frequency, 1800),
    ('bedroom',   'biweekly'::frequency, 1700), ('bedroom',   'weekly'::frequency,  1600),
    ('bathroom',  'one_time'::frequency, 2200), ('bathroom',  'monthly'::frequency, 2000),
    ('bathroom',  'biweekly'::frequency, 1900), ('bathroom',  'weekly'::frequency,  1800),
    ('half_bath', 'one_time'::frequency, 1100), ('half_bath', 'monthly'::frequency, 1000),
    ('half_bath', 'biweekly'::frequency, 1000), ('half_bath', 'weekly'::frequency,   900),
    ('kitchen',   'one_time'::frequency, 2000), ('kitchen',   'monthly'::frequency, 1800),
    ('kitchen',   'biweekly'::frequency, 1700), ('kitchen',   'weekly'::frequency,  1600),
    ('living',    'one_time'::frequency, 1700), ('living',    'monthly'::frequency, 1500),
    ('living',    'biweekly'::frequency, 1400), ('living',    'weekly'::frequency,  1300),
    ('utility',   'one_time'::frequency, 1100), ('utility',   'monthly'::frequency, 1000),
    ('utility',   'biweekly'::frequency, 1000), ('utility',   'weekly'::frequency,   900)
  ) as r(key, freq, cents) on r.key = i.item_key
  where i.service = 'standard';

  -- ---------------- DEEP CLEAN ---------------- (one-time + monthly only)
  insert into price_book_items (service,item_key,name,category,clean_minutes,is_countable,sort_order) values
    ('deep','arrival',   'Arrival',                          'arrival',45,false,1),
    ('deep','bedroom',   'Bedroom',                          'room',   27,true, 2),
    ('deep','bathroom',  'Bathroom',                         'room',   36,true, 3),
    ('deep','half_bath', 'Half Bathroom',                    'room',   18,true, 4),
    ('deep','kitchen',   'Kitchen',                          'room',   50,true, 5),
    ('deep','living',    'Living / Dining / Media / Office',  'room',  27,true, 6),
    ('deep','utility',   'Utility Room',                     'room',   14,true, 7);

  insert into price_book_rates (item_id, freq, price_cents)
  select i.id, r.freq, r.cents
  from price_book_items i
  join (values
    ('arrival',  'one_time'::frequency,10100), ('arrival',  'monthly'::frequency, 9100),
    ('bedroom',  'one_time'::frequency, 3400), ('bedroom',  'monthly'::frequency, 3000),
    ('bathroom', 'one_time'::frequency, 3600), ('bathroom', 'monthly'::frequency, 3300),
    ('half_bath','one_time'::frequency, 1900), ('half_bath','monthly'::frequency, 1700),
    ('kitchen',  'one_time'::frequency, 4500), ('kitchen',  'monthly'::frequency, 4100),
    ('living',   'one_time'::frequency, 2500), ('living',   'monthly'::frequency, 2300),
    ('utility',  'one_time'::frequency, 1700), ('utility',  'monthly'::frequency, 1500)
  ) as r(key, freq, cents) on r.key = i.item_key
  where i.service = 'deep';

  -- ---------------- MOVE IN / OUT ---------------- (one-time only)
  insert into price_book_items (service,item_key,name,category,clean_minutes,is_countable,sort_order) values
    ('move_in_out','arrival',   'Arrival',                          'arrival',60,false,1),
    ('move_in_out','bedroom',   'Bedroom',                          'room',   33,true, 2),
    ('move_in_out','bathroom',  'Bathroom',                         'room',   45,true, 3),
    ('move_in_out','half_bath', 'Half Bathroom',                    'room',   22,true, 4),
    ('move_in_out','kitchen',   'Kitchen',                          'room',   60,true, 5),
    ('move_in_out','living',    'Living / Dining / Media / Office',  'room',  33,true, 6),
    ('move_in_out','utility',   'Utility Room',                     'room',   18,true, 7);

  insert into price_book_rates (item_id, freq, price_cents)
  select i.id, 'one_time'::frequency, r.cents
  from price_book_items i
  join (values
    ('arrival',13400),('bedroom',3900),('bathroom',4500),('half_bath',2800),
    ('kitchen',5000),('living',3400),('utility',2200)
  ) as r(key, cents) on r.key = i.item_key
  where i.service = 'move_in_out';
end $$;

-- ---------------- EXTRAS ---------------- flat, never discounted
insert into price_book_extras (item_key,name,price_cents,unit_label,clean_minutes,sort_order) values
  ('pet_hair',     'Pet Hair / Excessive Pet Hair', 5000,'flat',   30, 1),
  ('cabinets',     'Inside Cabinets',               5000,'flat',   35, 2),
  ('oven',         'Oven Clean',                    5000,'flat',   30, 3),
  ('refrigerator', 'Refrigerator Clean',            2500,'flat',   20, 4),
  ('walls',        'Walls',                         2500,'flat',   20, 5),
  ('laundry',      'Laundry Service / Load',        2000,'per load',15,6),
  ('baseboards',   'Baseboards',                    5000,'flat',   30, 7),
  ('airbnb_laundry','Airbnb Laundry',               2500,'flat',   20, 8),
  ('feather_laundry','Feather Laundry',              299,'each',    5, 9),
  ('organization', 'Organization Service',          4000,'per hour',60,10)
on conflict (item_key) do nothing;

-- ============================================================================
-- Quoting. Reads the rate matrix directly — never applies a discount on top,
-- because the recurring columns already contain it.
-- ============================================================================
create or replace function quote_price(
  p_service   service_type,
  p_freq      frequency,
  p_bedrooms  integer,
  p_bathrooms integer,
  p_half_baths integer default 0,
  p_kitchens  integer default 1,
  p_living    integer default 1,
  p_utility   integer default 1
) returns table (total_cents integer, clean_minutes integer)
language plpgsql stable as $$
#variable_conflict use_column
declare
  v_rates integer;
begin
  -- FIX (0002 review): not every (service, frequency) pair exists -- Deep is
  -- one-time/monthly only, Move In/Out is one-time only. The original returned
  -- (0,0) for a missing pair, which quotes a job at $0 rather than failing.
  select count(*) into v_rates
  from price_book_items i
  join price_book_rates r on r.item_id = i.id and r.freq = p_freq
  where i.service = p_service and i.active;

  if v_rates = 0 then
    raise exception
      'no price book rates for service % at frequency %: Deep is one-time/monthly only, Move In/Out is one-time only',
      p_service, p_freq;
  end if;

  return query
  with qty(item_key, n) as (values
    ('arrival',1),('bedroom',p_bedrooms),('bathroom',p_bathrooms),
    ('half_bath',p_half_baths),('kitchen',p_kitchens),('living',p_living),('utility',p_utility)
  )
  select
    coalesce(sum(r.price_cents * q.n), 0)::integer,
    coalesce(sum(i.clean_minutes * q.n), 0)::integer
  from qty q
  join price_book_items i on i.item_key = q.item_key and i.service = p_service and i.active
  join price_book_rates r on r.item_id = i.id and r.freq = p_freq
  where q.n > 0;
end $$;

-- ============================================================================
-- CALIBRATION NOTE — read before trusting clean_minutes
--
-- The per-item minutes above are estimates chosen so a 2bd/2ba standard lands
-- at ~2.3 h and a 3bd/2ba at ~2.55 h, which brackets Shonda's stated 2.5 h
-- average. They are NOT measured. Once time_entries has real clocked data,
-- recalibrate with something like:
--
--   select j.estimated_clean_minutes, avg(t.clean_minutes), count(*)
--   from jobs j join time_entries t on t.job_id = j.id
--   where j.status = 'complete' group by 1 order by 1;
--
-- This matters more than it looks: payout is computed from estimated hours
-- (see lib/dispatch/engine.ts). Underestimated minutes mean underpaid offers
-- that never fill; overestimated means overpaying on every job.
-- ============================================================================
