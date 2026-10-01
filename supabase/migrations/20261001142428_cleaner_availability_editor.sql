-- Replace only the signed-in active cleaner's declaration in one transaction.
-- No service role or caller-supplied cleaner ID is involved; existing RLS applies.
create or replace function public.set_my_availability(p_windows jsonb)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_cleaner uuid;
begin
  select c.id into v_cleaner from public.cleaners c
  join public.profiles p on p.id = c.profile_id
  where p.id = auth.uid() and p.role::text = 'cleaner' and c.status::text = 'active';
  if v_cleaner is null then raise exception 'active cleaner required' using errcode = '42501'; end if;

  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'working windows required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_windows) < 1 or jsonb_array_length(p_windows) > 28 then
    raise exception 'provide between 1 and 28 working windows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_windows) w
    where jsonb_typeof(w) <> 'object' or jsonb_typeof(w->'day') is distinct from 'number'
      or coalesce(w->>'day','') !~ '^[0-6]$'
      or jsonb_typeof(w->'startsAt') is distinct from 'string'
      or jsonb_typeof(w->'endsAt') is distinct from 'string'
      or coalesce(w->>'startsAt','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(w->>'endsAt','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or (w->>'endsAt') <= (w->>'startsAt')) then
    raise exception 'invalid day or time window' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_windows) with ordinality a(w,n)
    join jsonb_array_elements(p_windows) with ordinality b(w,n) on a.n < b.n
    where a.w->>'day' = b.w->>'day' and a.w->>'startsAt' < b.w->>'endsAt'
      and b.w->>'startsAt' < a.w->>'endsAt') then
    raise exception 'overlapping working windows' using errcode = '22023';
  end if;

  -- Concurrent saves for one cleaner cannot interleave deletion and insertion.
  perform pg_advisory_xact_lock(hashtextextended('availability:' || v_cleaner::text, 0));
  delete from public.cleaner_availability where cleaner_id = v_cleaner;
  insert into public.cleaner_availability (cleaner_id, day_of_week, starts_at, ends_at)
    select v_cleaner, (w->>'day')::integer, (w->>'startsAt')::time, (w->>'endsAt')::time
    from jsonb_array_elements(p_windows) w;
end $$;
revoke all on function public.set_my_availability(jsonb) from public, anon, service_role;
grant execute on function public.set_my_availability(jsonb) to authenticated;
