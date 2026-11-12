-- Resolve pricing relations and helper calls independently of the caller's path.
alter function public.quote_price(public.service_type, public.frequency, integer, integer, integer, integer, integer, integer)
  set search_path = pg_catalog, public, pg_temp;
alter function public.quote_price_or_null(public.service_type, public.frequency, integer, integer, integer, integer, integer, integer)
  set search_path = pg_catalog, public, pg_temp;

-- These helpers only use built-in functions, types and literal values.
alter function public.app_schema_version() set search_path = pg_catalog, pg_temp;
alter function public.automation_lease_seconds() set search_path = pg_catalog, pg_temp;
alter function public.normalize_phone(text) set search_path = pg_catalog, pg_temp;
alter function public.provisional_cleaner_rating() set search_path = pg_catalog, pg_temp;
alter function public.rating_prior_weight() set search_path = pg_catalog, pg_temp;
