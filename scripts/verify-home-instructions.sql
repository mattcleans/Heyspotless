-- Run only in the throwaway verification database. Fixtures and grants roll back.
begin;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Broad client privileges stress the trigger as well as the ownership policy.
grant all on profiles, customers, properties to anon, authenticated, service_role;
insert into auth.users(id,email) values
 ('93000000-0000-0000-0000-000000000001','home-a@example.test'),
 ('93000000-0000-0000-0000-000000000002','home-b@example.test'),
 ('93000000-0000-0000-0000-000000000003','home-cleaner@example.test'),
 ('93000000-0000-0000-0000-000000000004','home-admin@example.test');
update profiles set role='cleaner' where id='93000000-0000-0000-0000-000000000003';
update profiles set role='admin' where id='93000000-0000-0000-0000-000000000004';
insert into customers(id,profile_id,first_name,last_name) values
 ('94000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','Home','A'),
 ('94000000-0000-0000-0000-000000000002','93000000-0000-0000-0000-000000000002','Home','B');
insert into properties(id,customer_id,street,city,zip,bedrooms,access_notes,pets) values
 ('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','Test home A','Test','75024',2,'Front door','Cat'),
 ('95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000002','Test home B','Test','75024',3,'Other home',null);
select set_config('request.jwt.claim.sub','93000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$
declare
  original jsonb := '{"gateCode":null,"accessNotes":"Front door","parkingNotes":null,"pets":"Cat"}';
  saved jsonb;
  attack text;
begin
  saved := set_my_home_instructions('95000000-0000-0000-0000-000000000001',' 1234 ','Side door','Driveway','Cat',original);
  if saved->>'gateCode' <> '1234' or (select access_notes from properties where id='95000000-0000-0000-0000-000000000001') <> 'Side door' then
    raise exception 'own home instructions were not saved';
  end if;
  if (select count(*) from properties) <> 1 then raise exception 'customer saw another home'; end if;
  -- Lost-response retries confirm the existing values without a false conflict.
  if set_my_home_instructions('95000000-0000-0000-0000-000000000001','1234','Side door','Driveway','Cat',original) <> saved then
    raise exception 'same-value retry did not confirm saved state';
  end if;
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000001','1234','Stale change','Driveway','Cat',original);
    raise exception 'stale edits overwrote current instructions';
  exception when serialization_failure then null;
  end;
  if (select access_notes from properties where id='95000000-0000-0000-0000-000000000001') <> 'Side door' then raise exception 'conflict changed instructions'; end if;
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000002',null,'Foreign change',null,null,saved);
    raise exception 'customer wrote another home';
  exception when insufficient_privilege then null;
  end;
  foreach attack in array array[
    $q$update properties set street='Forged address' where id='95000000-0000-0000-0000-000000000001'$q$,
    $q$update properties set bedrooms=99 where id='95000000-0000-0000-0000-000000000001'$q$,
    $q$update properties set customer_id='94000000-0000-0000-0000-000000000002' where id='95000000-0000-0000-0000-000000000001'$q$,
    $q$update properties set id='95000000-0000-0000-0000-000000000003' where id='95000000-0000-0000-0000-000000000001'$q$
  ] loop
    begin execute attack; raise exception 'non-instruction write succeeded: %',attack;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    update properties set gate_code=repeat('x',201) where id='95000000-0000-0000-0000-000000000001';
    raise exception 'direct write bypassed length limit';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000001',null,repeat('x',1001),null,null,saved);
    raise exception 'RPC bypassed length limit';
  exception when invalid_parameter_value then null;
  end;
  update properties set access_notes='Latest office change' where id='95000000-0000-0000-0000-000000000001';
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000001','1234','Stale draft','Driveway','Cat',saved);
    raise exception 'later direct edit was overwritten';
  exception when serialization_failure then null;
  end;
  saved := jsonb_build_object('gateCode','1234','accessNotes','Latest office change','parkingNotes','Driveway','pets','Cat');
  perform set_my_home_instructions('95000000-0000-0000-0000-000000000001',null,null,null,null,saved);
  if exists (select 1 from properties where gate_code is not null or access_notes is not null or parking_notes is not null or pets is not null) then
    raise exception 'clear instructions did not persist';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','93000000-0000-0000-0000-000000000002',true);
set local role authenticated;
select set_my_home_instructions('95000000-0000-0000-0000-000000000002',null,'Other home',null,'Dog',
  '{"gateCode":null,"accessNotes":"Other home","parkingNotes":null,"pets":null}');
do $$ begin
  if (select count(*) from properties) <> 1 then raise exception 'second customer saw another home'; end if;
  if exists(select 1 from properties where id='95000000-0000-0000-0000-000000000001') then raise exception 'second customer saw first home'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','93000000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000001',null,null,null,null,
      '{"gateCode":null,"accessNotes":null,"parkingNotes":null,"pets":null}');
    raise exception 'cleaner changed home instructions';
  exception when insufficient_privilege then null;
  end;
  update properties set access_notes='Cleaner attack' where id='95000000-0000-0000-0000-000000000001';
  if found then raise exception 'cleaner direct update succeeded'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','93000000-0000-0000-0000-000000000004',true);
set local role authenticated;
update properties set street='Admin address correction',bedrooms=4 where id='95000000-0000-0000-0000-000000000001';
do $$ begin
  if (select bedrooms from properties where id='95000000-0000-0000-0000-000000000001') <> 4 then raise exception 'existing admin edit blocked'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role service_role;
update properties set city='Trusted import correction' where id='95000000-0000-0000-0000-000000000001';
reset role;
set local role anon;
do $$ begin
  begin
    perform set_my_home_instructions('95000000-0000-0000-0000-000000000001',null,null,null,null,
      '{"gateCode":null,"accessNotes":null,"parkingNotes":null,"pets":null}');
    raise exception 'anonymous instructions RPC succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  if (select pets from properties where id='95000000-0000-0000-0000-000000000002') <> 'Dog' then raise exception 'second home update lost'; end if;
  if (select city from properties where id='95000000-0000-0000-0000-000000000001') <> 'Trusted import correction' then raise exception 'service import edit blocked'; end if;
end $$;
rollback;
