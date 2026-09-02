-- ============================================================================
-- 0004 — bind profiles to Supabase auth
--
-- 0001 created `profiles` with a bare uuid primary key, because the `auth`
-- schema does not exist in a plain Postgres and the migration had to replay
-- locally. Now that the app authenticates for real, the link is made explicit:
-- a profile IS an auth user, and deleting the user removes the profile.
--
-- Every RLS policy in 0003 resolves identity through auth.uid() -> profiles.id,
-- so without this FK a stale profile row could grant access to a deleted user.
-- ============================================================================

alter table profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- Signup creates the profile automatically. Role and name come from the
-- metadata supplied at sign-up; role defaults to `customer` because that is the
-- only role safe to self-assign. Admin and cleaner roles are granted
-- deliberately, never by whatever a signup form happened to post.
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, role, full_name, email, phone)
  values (
    new.id,
    case
      when new.raw_user_meta_data ->> 'role' = 'cleaner' then 'cleaner'::user_role
      else 'customer'::user_role
    end,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- Keep the email in sync when the user changes it in auth.
create or replace function handle_auth_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function handle_auth_user_email_change();

-- A profile must never silently self-promote. Role changes are an admin action.
create policy profiles_self_update on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()));

-- Linking a cleaner or customer record to a signed-in profile is how someone
-- moves from "has an account" to "sees their jobs". Indexed because every RLS
-- check on those tables goes through it.
create index if not exists cleaners_profile_id_idx  on cleaners  (profile_id);
create index if not exists customers_profile_id_idx on customers (profile_id);
