-- Run only in the throwaway verification database. All fixtures roll back.
begin;
grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated;
grant select on profiles, cleaners to authenticated;
grant select, insert, update, delete on cleaner_availability to authenticated;
insert into auth.users(id,email) values
 ('96000000-0000-0000-0000-000000000001','availability-a@example.test'),
 ('96000000-0000-0000-0000-000000000002','availability-b@example.test'),
 ('96000000-0000-0000-0000-000000000003','availability-admin@example.test');
update profiles set role='cleaner' where id in ('96000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000002');
update profiles set role='admin' where id='96000000-0000-0000-0000-000000000003';
insert into cleaners(id,profile_id,full_name,type,status) values
 ('97000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000001','Availability A','w2_core','active'),
 ('97000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000002','Availability B','w2_core','active');
insert into cleaner_availability(cleaner_id,day_of_week,starts_at,ends_at) values
 ('97000000-0000-0000-0000-000000000002',2,'10:00','15:00');
select set_config('request.jwt.claim.sub','96000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select set_my_availability('[{"day":1,"startsAt":"09:00","endsAt":"12:00","cleaner_id":"97000000-0000-0000-0000-000000000002"},{"day":1,"startsAt":"13:00","endsAt":"17:00"}]');
do $$
declare payload jsonb;
begin
  if (select count(*) from cleaner_availability) <> 2 then raise exception 'split shift not saved to own schedule'; end if;
  foreach payload in array array[
    '[]'::jsonb, 'null'::jsonb,
    '[{"day":7,"startsAt":"09:00","endsAt":"12:00"}]'::jsonb,
    '[{"day":1,"startsAt":"24:00","endsAt":"25:00"}]'::jsonb,
    '[{"day":1,"startsAt":"17:00","endsAt":"09:00"}]'::jsonb,
    '[{"day":1,"startsAt":"09:00","endsAt":"13:00"},{"day":1,"startsAt":"12:00","endsAt":"15:00"}]'::jsonb
  ] loop
    begin
      perform set_my_availability(payload);
      raise exception 'invalid working hours accepted';
    exception when invalid_parameter_value then null;
    end;
    if (select count(*) from cleaner_availability) <> 2 then raise exception 'failed save changed prior schedule'; end if;
  end loop;
end $$;
select set_my_availability('[{"day":3,"startsAt":"09:00","endsAt":"12:00"}]');
reset role;
do $$ begin
  if (select count(*) from cleaner_availability where cleaner_id='97000000-0000-0000-0000-000000000001') <> 1 then raise exception 'save did not replace the prior schedule'; end if;
  if (select count(*) from cleaner_availability where cleaner_id='97000000-0000-0000-0000-000000000002') <> 1 then raise exception 'save touched another cleaner'; end if;
end $$;
select set_config('request.jwt.claim.sub','96000000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
  begin
    perform set_my_availability('[{"day":1,"startsAt":"09:00","endsAt":"12:00"}]');
    raise exception 'admin used self-service cleaner save';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform set_my_availability('[{"day":1,"startsAt":"09:00","endsAt":"12:00"}]');
    raise exception 'anonymous save accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
