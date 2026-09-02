-- ============================================================================
-- 0003 — row-level security, and the eligibility gate
--
-- Plan section 03: "Row-level security in Postgres means a cleaner physically
-- cannot query another cleaner's earnings — the rule lives in the database,
-- not in the UI where a bug can leak it."
--
-- Plan section 04: "This is a database-level filter, so no dispatch bug and no
-- manual override can accidentally send your customer someone who hasn't
-- cleared a background check."
-- ============================================================================

-- `service` was text in 0001 because service_type is not created until 0002.
-- Now that it exists, constrain the columns properly.
alter table recurring_plans alter column service type service_type using service::service_type;
alter table quotes          alter column service type service_type using service::service_type;
alter table jobs            alter column service type service_type using service::service_type;

-- --------------------------------------------------------------- helpers --
create or replace function current_role_of() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

-- The caller's cleaner row, if they are one.
create or replace function current_cleaner_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from cleaners where profile_id = auth.uid();
$$;

create or replace function current_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from customers where profile_id = auth.uid();
$$;

-- ============================================================================
-- THE ELIGIBILITY GATE
--
-- The single source of truth for "may this cleaner be offered this job".
-- The 3.9 floor is non-negotiable in code (plan section 02). Enforced below as
-- a CHECK on the offers table, so an offer to an ineligible cleaner cannot be
-- written at all -- not by the dispatch engine, not by a manual override, not
-- by a direct SQL statement from an admin.
-- ============================================================================
create or replace function cleaner_is_eligible(p_cleaner_id uuid, p_job_id uuid)
returns boolean
language sql stable as $$
  select exists (
    select 1
    from cleaners c
    join jobs j on j.id = p_job_id
    join properties p on p.id = j.property_id
    where c.id = p_cleaner_id
      and c.status = 'active'
      and coalesce(c.rating, 0) >= 3.9                     -- quality floor
      and c.background_check_cleared                        -- never overridable
      and (c.insurance_expires_on is null
           or c.insurance_expires_on > coalesce(j.scheduled_start::date, current_date))
      and (cardinality(c.service_zips) = 0 or p.zip = any (c.service_zips))
      -- not already committed in the window
      and not exists (
        select 1
        from job_assignments ja
        join jobs oj on oj.id = ja.job_id
        where ja.cleaner_id = c.id
          and oj.id <> j.id
          and oj.status in ('scheduled', 'assigned', 'in_progress')
          and j.scheduled_start is not null
          and oj.scheduled_start is not null
          and tstzrange(oj.scheduled_start, coalesce(oj.scheduled_end, oj.scheduled_start))
              && tstzrange(j.scheduled_start, coalesce(j.scheduled_end, j.scheduled_start))
      )
  );
$$;

alter table offers
  add constraint offers_cleaner_must_be_eligible
  check (cleaner_is_eligible(cleaner_id, job_id)) not valid;

-- ------------------------------------------------------------- enable -----
alter table profiles             enable row level security;
alter table customers            enable row level security;
alter table properties           enable row level security;
alter table cleaners             enable row level security;
alter table cleaner_availability enable row level security;
alter table recurring_plans      enable row level security;
alter table quotes               enable row level security;
alter table quote_line_items     enable row level security;
alter table jobs                 enable row level security;
alter table offers               enable row level security;
alter table job_assignments      enable row level security;
alter table time_entries         enable row level security;
alter table checklists           enable row level security;
alter table job_photos           enable row level security;
alter table ratings              enable row level security;
alter table invoices             enable row level security;
alter table payments             enable row level security;
alter table payouts              enable row level security;
alter table leads                enable row level security;
alter table messages             enable row level security;
alter table automations          enable row level security;
alter table applications         enable row level security;
alter table price_book_items     enable row level security;
alter table price_book_rates     enable row level security;
alter table price_book_extras    enable row level security;
alter table mileage_rates        enable row level security;

-- ------------------------------------------------------------ policies ----
-- Admin sees everything, everywhere.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','customers','properties','cleaners','cleaner_availability',
    'recurring_plans','quotes','quote_line_items','jobs','offers','job_assignments',
    'time_entries','checklists','job_photos','ratings','invoices','payments','payouts',
    'leads','messages','automations','applications','price_book_items',
    'price_book_rates','price_book_extras','mileage_rates'
  ] loop
    execute format(
      'create policy %I on %I for all using (is_admin()) with check (is_admin())',
      t || '_admin_all', t);
  end loop;
end $$;

-- Everyone signed in reads their own profile.
create policy profiles_self on profiles for select using (id = auth.uid());

-- The price book is readable by any authenticated user: the cleaner app shows
-- job value, the booking widget quotes from it.
create policy price_items_read  on price_book_items  for select using (auth.uid() is not null);
create policy price_rates_read  on price_book_rates  for select using (auth.uid() is not null);
create policy price_extras_read on price_book_extras for select using (auth.uid() is not null);

-- ---- cleaner -------------------------------------------------------------
-- A cleaner sees only their own row. This is the earnings-isolation rule.
create policy cleaners_self on cleaners for select
  using (profile_id = auth.uid());

create policy cleaner_availability_self on cleaner_availability for all
  using (cleaner_id = current_cleaner_id())
  with check (cleaner_id = current_cleaner_id());

-- Only their own offers -- a cleaner cannot see what anyone else was offered,
-- which is what keeps the auction ladder invisible (plan section 04).
create policy offers_own on offers for select
  using (cleaner_id = current_cleaner_id());
create policy offers_respond on offers for update
  using (cleaner_id = current_cleaner_id())
  with check (cleaner_id = current_cleaner_id());

create policy assignments_own on job_assignments for select
  using (cleaner_id = current_cleaner_id());

-- Jobs they are assigned to, or that are open on the board.
create policy jobs_assigned_or_open on jobs for select using (
  exists (select 1 from job_assignments ja
          where ja.job_id = jobs.id and ja.cleaner_id = current_cleaner_id())
  or (dispatch_channel = 'open_board' and status in ('unscheduled','scheduled','dispatching'))
);

-- The property address is visible only for a job they actually hold. Gate
-- codes and access notes must not leak to the whole cleaner pool.
create policy properties_for_assigned_job on properties for select using (
  exists (select 1 from jobs j
          join job_assignments ja on ja.job_id = j.id
          where j.property_id = properties.id and ja.cleaner_id = current_cleaner_id())
);
create policy customers_for_assigned_job on customers for select using (
  exists (select 1 from jobs j
          join job_assignments ja on ja.job_id = j.id
          where j.customer_id = customers.id and ja.cleaner_id = current_cleaner_id())
);

create policy time_entries_own on time_entries for all
  using (cleaner_id = current_cleaner_id())
  with check (cleaner_id = current_cleaner_id());

create policy payouts_own on payouts for select
  using (cleaner_id = current_cleaner_id());

create policy checklists_own_job on checklists for all using (
  exists (select 1 from job_assignments ja
          where ja.job_id = checklists.job_id and ja.cleaner_id = current_cleaner_id())
) with check (
  exists (select 1 from job_assignments ja
          where ja.job_id = checklists.job_id and ja.cleaner_id = current_cleaner_id())
);

create policy job_photos_own_job on job_photos for all using (
  exists (select 1 from job_assignments ja
          where ja.job_id = job_photos.job_id and ja.cleaner_id = current_cleaner_id())
) with check (
  exists (select 1 from job_assignments ja
          where ja.job_id = job_photos.job_id and ja.cleaner_id = current_cleaner_id())
);

-- ---- customer ------------------------------------------------------------
create policy customers_self on customers for select
  using (profile_id = auth.uid());

create policy properties_own on properties for select
  using (customer_id = current_customer_id());

create policy jobs_own on jobs for select
  using (customer_id = current_customer_id());

create policy quotes_own on quotes for select
  using (customer_id = current_customer_id());

create policy quote_lines_own on quote_line_items for select using (
  exists (select 1 from quotes q
          where q.id = quote_line_items.quote_id and q.customer_id = current_customer_id())
);

create policy plans_own on recurring_plans for select
  using (customer_id = current_customer_id());

create policy invoices_own on invoices for select
  using (customer_id = current_customer_id());

create policy payments_own on payments for select using (
  exists (select 1 from invoices i
          where i.id = payments.invoice_id and i.customer_id = current_customer_id())
);

-- A customer rates their own clean; that score feeds dispatch eligibility.
create policy ratings_own on ratings for all
  using (customer_id = current_customer_id())
  with check (customer_id = current_customer_id());

create policy messages_own on messages for select
  using (customer_id = current_customer_id());

create policy job_photos_own_property on job_photos for select using (
  exists (select 1 from jobs j
          where j.id = job_photos.job_id and j.customer_id = current_customer_id())
);
