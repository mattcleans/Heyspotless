-- The caller's temporary relations must not replace the saved price book.
begin;
create temporary table helper_path_expected as
  select * from public.quote_price('standard', 'biweekly', 2, 2);
create temporary table price_book_items (like public.price_book_items);
create temporary table price_book_rates (like public.price_book_rates);
set local search_path = pg_temp;

do $$
declare expected record; actual record;
begin
  select * into expected from helper_path_expected;
  select * into actual from public.quote_price('standard', 'biweekly', 2, 2);
  if actual is distinct from expected then
    raise exception 'Caller path changed the saved-home quote';
  end if;
  if public.quote_price_or_null('standard', 'biweekly', 2, 2) is distinct from expected.total_cents then
    raise exception 'Caller path changed the quote wrapper';
  end if;
  if public.quote_price_or_null('move_in_out', 'weekly', 2, 2) is not null then
    raise exception 'Unsupported service frequency stopped returning null';
  end if;
  if public.normalize_phone('+1 (469) 280-0397') <> '4692800397'
    or public.normalize_phone(null) is not null
    or public.normalize_phone('123') <> '123' then
    raise exception 'Phone normalization changed';
  end if;
  if public.app_schema_version() <> 29
    or public.automation_lease_seconds() <> 120
    or public.provisional_cleaner_rating() <> 4.2
    or public.rating_prior_weight() <> 5 then
    raise exception 'Constant helper values changed';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('quote_price', 'quote_price_or_null', 'normalize_phone',
        'app_schema_version', 'automation_lease_seconds',
        'provisional_cleaner_rating', 'rating_prior_weight')
      and (p.prosecdef or p.proconfig is null)
  ) then
    raise exception 'Helper path or invoker security changed';
  end if;
end $$;
rollback;
