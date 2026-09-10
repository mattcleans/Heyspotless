-- Restrict privileged billing writes to the server and close role/offer gaps.
-- Supabase supplies these roles. The verification harness creates stand-ins.
-- Revoking PUBLIC alone is insufficient when a project also has explicit
-- default grants to anon/authenticated.
begin;

revoke all on function record_payment(uuid, integer, integer, text, text, text, boolean, text)
  from public, anon, authenticated;
revoke all on function record_refund(text, integer, text, uuid, text)
  from public, anon, authenticated;
revoke all on function record_autocharge_failure(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function resettle_invoice(uuid)
  from public, anon, authenticated;

grant execute on function record_payment(uuid, integer, integer, text, text, text, boolean, text)
  to service_role;
grant execute on function record_refund(text, integer, text, uuid, text)
  to service_role;
grant execute on function record_autocharge_failure(uuid, text, timestamptz)
  to service_role;
grant execute on function resettle_invoice(uuid)
  to service_role;

-- Owning an offer must not permit changing its payout, cleaner or job.
-- The cleaner screen is still read-only. Keep cleaner writes disabled until
-- accept/decline is implemented as a validated, atomic dispatch operation.
-- The existing admin policy and service-role operations remain available.
drop policy offers_respond on offers;

-- An open-board job is visible to staff, not every signed-in customer.
-- Existing customer ownership and admin policies still apply independently.
drop policy jobs_assigned_or_open on jobs;
create policy jobs_assigned_or_open on jobs for select using (
  current_role_of() = 'cleaner'
  and current_cleaner_id() is not null
  and (
    exists (select 1 from job_assignments ja
            where ja.job_id = jobs.id and ja.cleaner_id = current_cleaner_id())
    or (dispatch_channel = 'open_board'
        and status in ('unscheduled', 'scheduled', 'dispatching'))
  )
);

-- Signup metadata is supplied by the user. Staff roles require a separate
-- administrator action, regardless of what a signup client requests.
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, role, full_name, email, phone)
  values (
    new.id,
    'customer'::user_role,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

commit;
