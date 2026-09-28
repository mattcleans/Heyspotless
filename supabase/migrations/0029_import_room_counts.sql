-- ============================================================================
-- 0029 — every room the export states
--
-- The Housecall Pro export states a house's size in the job description:
--
--   House Cleaning, 3 x Bedrooms, 2 x Full Baths, 0 x Half Baths, 1 x Kitchen,
--   0 x Utility Room, 1 x Living Room / Dining Room / Games Room
--
-- `quote_price_or_null` prices kitchens, living rooms and utility rooms as well
-- as bedrooms and baths, and `recurring_price_audit` reads all six off the
-- property. `import_property` (0025) took only three, so a house with no
-- utility room was audited as if it had one — the column default — and its
-- book price, and so the audit's verdict, was off by whatever a utility room
-- costs.
--
-- This replaces `import_property` with the same function plus those three
-- counts. 0025 is not edited: it has already been applied to production.
--
-- THE RULES ARE 0025's, and one is sharpened:
--
--   - A count somebody verified in this app (`size_verified_source` is no
--     longer 'hcp_import') is never overwritten by a re-run. Unchanged.
--   - NULL MEANS "NOT STATED", for all six counts. On insert it falls back to
--     the column's default; on a re-run it leaves the stored count alone.
--     Previously a re-run without room data reset bedrooms and baths to zero,
--     which a re-run with fewer jobs in the export could do by accident.
--
-- Dropped and recreated rather than overloaded: two `import_property`
-- signatures that both accept the old argument list make every PostgREST call
-- ambiguous, and the importer would fail on migration night.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 29 $$;

drop function import_property(text, uuid, text, text, text, text, integer, integer,
                              integer, text, text);

create function import_property(
  p_hcp_address_id text,
  p_customer_id uuid,
  p_street text,
  p_city   text,
  p_zip    text,
  p_state  text default 'TX',
  p_bedrooms integer default null,
  p_bathrooms integer default null,
  p_half_baths integer default null,
  p_access_notes text default null,
  p_gate_code text default null,
  p_kitchens integer default null,
  p_living_rooms integer default null,
  p_utility_rooms integer default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into properties (hcp_address_id, customer_id, street, city, state, zip,
                          bedrooms, bathrooms, half_baths,
                          kitchens, living_rooms, utility_rooms,
                          access_notes, gate_code, size_verified_source)
  values (p_hcp_address_id, p_customer_id, p_street, p_city, p_state, p_zip,
          greatest(0, coalesce(p_bedrooms, 0)),
          greatest(0, coalesce(p_bathrooms, 0)),
          greatest(0, coalesce(p_half_baths, 0)),
          -- The column defaults from 0001: one of each, which is most houses.
          greatest(0, coalesce(p_kitchens, 1)),
          greatest(0, coalesce(p_living_rooms, 1)),
          greatest(0, coalesce(p_utility_rooms, 1)),
          p_access_notes, p_gate_code,
          -- Unverified, as in 0025: whatever somebody typed into a quote.
          'hcp_import')
  on conflict (hcp_address_id) where hcp_address_id is not null do update set
    street = excluded.street,
    city   = excluded.city,
    zip    = excluded.zip,
    bedrooms = case when properties.size_verified_source = 'hcp_import' and p_bedrooms is not null
                    then excluded.bedrooms else properties.bedrooms end,
    bathrooms = case when properties.size_verified_source = 'hcp_import' and p_bathrooms is not null
                     then excluded.bathrooms else properties.bathrooms end,
    half_baths = case when properties.size_verified_source = 'hcp_import' and p_half_baths is not null
                      then excluded.half_baths else properties.half_baths end,
    kitchens = case when properties.size_verified_source = 'hcp_import' and p_kitchens is not null
                    then excluded.kitchens else properties.kitchens end,
    living_rooms = case when properties.size_verified_source = 'hcp_import' and p_living_rooms is not null
                        then excluded.living_rooms else properties.living_rooms end,
    utility_rooms = case when properties.size_verified_source = 'hcp_import' and p_utility_rooms is not null
                         then excluded.utility_rooms else properties.utility_rooms end,
    access_notes = coalesce(properties.access_notes, excluded.access_notes),
    gate_code    = coalesce(properties.gate_code, excluded.gate_code)
  returning id into v_id;

  return v_id;
end $$;

revoke all on function import_property(text, uuid, text, text, text, text, integer, integer,
                                       integer, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function import_property(text, uuid, text, text, text, text, integer, integer,
                                          integer, text, text, integer, integer, integer)
  to service_role;
