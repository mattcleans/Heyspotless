-- ============================================================================
-- Seed data for a fresh Spotless Ops project.
--
--   supabase db reset          (applies migrations, then this)
--   psql "$DATABASE_URL" -f supabase/seed.sql
--
-- Representative, not real customer data. The two W-2 cleaners carry the actual
-- terms from the build plan so dispatch behaves realistically out of the box.
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ------------------------------------------------------------- cleaners ----
insert into cleaners (
  id, full_name, type, status, rating, acceptance_rate, background_check_cleared,
  service_zips, hourly_rate_cents, guaranteed_hours_per_week, overtime_multiplier,
  employer_burden_rate, uses_company_vehicle, drive_time_paid,
  mileage_reimbursed, between_job_miles_reimbursed, commute_free_miles
) values
  ('11111111-1111-1111-1111-111111111101', 'Shonda', 'w2_core', 'active', 4.8, 1.00, true,
   '{}', 1750, 40, 1.5, 0.15, true,  true, false, false, 0),
  ('11111111-1111-1111-1111-111111111102', 'Iggy',   'w2_core', 'active', 4.7, 1.00, true,
   '{}', 2100, null, 1.5, 0.15, false, true, true,  true,  20)
on conflict (id) do nothing;

-- The marketplace pool. Small on purpose: below roughly ten active vetted
-- cleaners the waterfall is just sequential phone calls with a nicer interface.
insert into cleaners (
  id, full_name, type, status, rating, acceptance_rate, background_check_cleared,
  service_zips, default_payout_rate
) values
  ('11111111-1111-1111-1111-111111111103', 'Marisol A.', 'contractor_1099', 'active', 4.8, 0.86, true,
   '{75024,75034,75002}', 0.35),
  ('11111111-1111-1111-1111-111111111104', 'Dee W.',     'contractor_1099', 'active', 4.5, 0.61, true,
   '{75024,75080}', 0.35),
  ('11111111-1111-1111-1111-111111111105', 'Priya N.',   'contractor_1099', 'active', 4.2, 0.94, true,
   '{}', 0.35),
  -- Below the 3.9 floor: should never receive an offer.
  ('11111111-1111-1111-1111-111111111106', 'Tomás R.',   'contractor_1099', 'active', 3.6, 0.72, true,
   '{76102}', 0.35),
  -- Background check not cleared: should never receive an offer.
  ('11111111-1111-1111-1111-111111111107', 'Janelle B.', 'contractor_1099', 'active', 4.9, 0.55, false,
   '{}', 0.35)
on conflict (id) do nothing;

-- ------------------------------------------------ customers & properties ---
insert into customers (id, first_name, last_name, email, phone, first_contact_date) values
  ('22222222-2222-2222-2222-222222222201', 'Bonnie',   'Cornell',   'bonnie@example.com',   '4695550101', '2026-01-14'),
  ('22222222-2222-2222-2222-222222222202', 'Ann',      'Lutich',    'ann@example.com',      '4695550102', '2026-02-03'),
  ('22222222-2222-2222-2222-222222222203', 'Jennifer', 'Vaughn',    'jennifer@example.com', '4695550103', '2026-06-21'),
  ('22222222-2222-2222-2222-222222222204', 'Jonathan', 'Ruiz',      'jonathan@example.com', '4695550104', '2026-07-02'),
  ('22222222-2222-2222-2222-222222222205', 'Tabitha',  'Holmes',    'tabitha@example.com',  '4695550105', '2026-08-11'),
  ('22222222-2222-2222-2222-222222222206', 'Sorab',    'Mistry',    'sorab@example.com',    '4695550106', '2026-08-19'),
  ('22222222-2222-2222-2222-222222222207', 'Veena',    'Mahadevan', 'veena@example.com',    '4695550107', '2026-05-30')
on conflict (id) do nothing;

insert into properties (id, customer_id, street, city, state, zip, bedrooms, bathrooms, size_verified_source) values
  ('33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222201', '3412 Legacy Dr',       'Plano',      'TX', '75024', 2, 2, 'zillow'),
  ('33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222202', '781 Ohio Dr',          'Plano',      'TX', '75024', 2, 2, 'zillow'),
  ('33333333-3333-3333-3333-333333333303', '22222222-2222-2222-2222-222222222203', '1290 Main St',         'Frisco',     'TX', '75034', 3, 2, 'zillow'),
  ('33333333-3333-3333-3333-333333333304', '22222222-2222-2222-2222-222222222204', '455 Bethany Rd',       'Allen',      'TX', '75002', 3, 2, 'zillow'),
  ('33333333-3333-3333-3333-333333333305', '22222222-2222-2222-2222-222222222205', '902 Custer Rd',        'Richardson', 'TX', '75080', 3, 2, 'zillow'),
  ('33333333-3333-3333-3333-333333333306', '22222222-2222-2222-2222-222222222206', '6100 Camp Bowie Blvd', 'Fort Worth', 'TX', '76102', 4, 4, 'zillow'),
  ('33333333-3333-3333-3333-333333333307', '22222222-2222-2222-2222-222222222207', '2200 Preston Rd',      'Plano',      'TX', '75024', 3, 2, 'zillow')
on conflict (id) do nothing;

-- ----------------------------------------------------------------- jobs ----
-- Prices and durations come from quote_price(), so the seed cannot drift from
-- the price book. Scheduled relative to now() so the board is always live.
insert into jobs (
  id, customer_id, property_id, status, service, freq,
  scheduled_start, scheduled_end, price_cents, estimated_clean_minutes
)
select
  v.id::uuid, v.customer_id::uuid, v.property_id::uuid, 'scheduled'::job_status,
  v.service::service_type, v.freq::frequency,
  now() + (v.hours_out || ' hours')::interval,
  now() + (v.hours_out || ' hours')::interval + (q.clean_minutes || ' minutes')::interval,
  q.total_cents, q.clean_minutes
from (values
  ('44444444-4444-4444-4444-444444444401', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'standard',    'biweekly', 2, 2, 26),
  ('44444444-4444-4444-4444-444444444402', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', 'standard',    'weekly',   2, 2, 74),
  ('44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', 'deep',        'one_time', 3, 2, 120),
  ('44444444-4444-4444-4444-444444444404', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', 'deep',        'one_time', 3, 2, 18),
  ('44444444-4444-4444-4444-444444444405', '22222222-2222-2222-2222-222222222205', '33333333-3333-3333-3333-333333333305', 'standard',    'one_time', 3, 2, 8),
  ('44444444-4444-4444-4444-444444444406', '22222222-2222-2222-2222-222222222206', '33333333-3333-3333-3333-333333333306', 'move_in_out', 'one_time', 4, 4, 40),
  ('44444444-4444-4444-4444-444444444407', '22222222-2222-2222-2222-222222222207', '33333333-3333-3333-3333-333333333307', 'standard',    'monthly',  3, 2, 96)
) as v(id, customer_id, property_id, service, freq, beds, baths, hours_out)
cross join lateral quote_price(v.service::service_type, v.freq::frequency, v.beds, v.baths) q
on conflict (id) do nothing;

-- Two already on Shonda's plate, so the guaranteed-hours maths has something to
-- work against and the idle-hours tile is not trivially "40 hours free".
insert into job_assignments (job_id, cleaner_id, is_lead, payout_cents)
values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111101', true, 0),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111101', true, 0)
on conflict (job_id, cleaner_id) do nothing;

update jobs set status = 'assigned'
where id in ('44444444-4444-4444-4444-444444444401', '44444444-4444-4444-4444-444444444402');
