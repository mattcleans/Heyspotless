-- Isolated verification database only. No provider calls; all rows roll back.
begin;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated;
grant select on profiles,customers,properties,jobs,job_assignments,cleaners to authenticated;
insert into auth.users(id,email) values
 ('91000000-0000-0000-0000-000000000001','choice-client-a@example.test'),
 ('91000000-0000-0000-0000-000000000002','choice-client-b@example.test'),
 ('91000000-0000-0000-0000-000000000003','choice-admin@example.test'),
 ('91000000-0000-0000-0000-000000000004','choice-cleaner@example.test');
update profiles set role='admin' where id='91000000-0000-0000-0000-000000000003';
update profiles set role='cleaner' where id='91000000-0000-0000-0000-000000000004';
insert into customers(id,profile_id,first_name,last_name) values
 ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','Choice','A'),
 ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000002','Choice','B');
insert into properties(id,customer_id,street,city,zip) values
 ('93000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','Sample A','Dallas','75001'),
 ('93000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000002','Sample B','Dallas','75001');
insert into cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared,profile_published) values
 ('94000000-0000-0000-0000-000000000001',null,'Preferred','contractor_1099','active',4.5,true,true),
 ('94000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000004','Backup','contractor_1099','active',4.5,true,true),
 ('94000000-0000-0000-0000-000000000003',null,'Replacement','contractor_1099','active',4.5,true,true);
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes) values
 ('95000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','scheduled','standard','one_time',20000,60),
 ('95000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000002','93000000-0000-0000-0000-000000000002','scheduled','standard','one_time',20000,60);
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select request_my_visit_cleaner('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000002','Keep my usual cleaner',null);
-- Same retry is idempotent and cannot create a duplicate pending request.
select request_my_visit_cleaner('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000002','Keep my usual cleaner',null);
do $$ begin
  if (select count(*) from visit_cleaner_requests)<>1 then raise exception 'retry created a duplicate'; end if;
  begin
    perform request_my_visit_cleaner('95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000003','',null);
    raise exception 'requested another client visit';
  exception when insufficient_privilege then null; end;
  begin
    perform review_visit_cleaner_request('96000000-0000-0000-0000-000000000002',true,'Client request');
    raise exception 'client reviewed own request';
  exception when insufficient_privilege then null; end;
  begin
    update visit_cleaner_requests set status='applied';
    raise exception 'direct status mutation allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform request_my_visit_cleaner('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000003','Stale request',null);
    raise exception 'stale request overwrote current request';
  exception when serialization_failure then null; end;
end $$;
-- A newer replacement must stay latest even with same-transaction timestamps
-- and a UUID that sorts BEFORE the first request.
select request_my_visit_cleaner('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000001','Preferred please','96000000-0000-0000-0000-000000000002');
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from visit_cleaner_requests) then raise exception 'client B read client A request'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
set local role authenticated;
select review_visit_cleaner_request('96000000-0000-0000-0000-000000000001',true,'Use preference in normal matching');
select review_visit_cleaner_request('96000000-0000-0000-0000-000000000001',true,'Use preference in normal matching');
reset role;
do $$ begin
 if (select preferred_cleaner_id from jobs where id='95000000-0000-0000-0000-000000000001')<>'94000000-0000-0000-0000-000000000001' then raise exception 'preference not applied'; end if;
 if exists(select 1 from job_assignments where job_id='95000000-0000-0000-0000-000000000001') then raise exception 'preference silently assigned a contractor'; end if;
end $$;
-- The engine/offer path assigned a different lead: require explicit client consent.
insert into job_assignments(id,job_id,cleaner_id,payout_cents) values
 ('97000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002',8000);
update jobs set status='assigned' where id='95000000-0000-0000-0000-000000000001';
do $$ begin
 begin
  perform start_job('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002');
  raise exception 'backup started without client approval';
 exception when sqlstate 'PBC01' then null; end;
 if exists(select 1 from time_entries where job_id='95000000-0000-0000-0000-000000000001') then raise exception 'blocked start wrote time entry'; end if;
 begin
  update jobs set status='complete' where id='95000000-0000-0000-0000-000000000001';
  raise exception 'direct completion bypassed backup approval';
 exception when sqlstate 'PBC01' then null; end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 if (select count(*) from client_visit_assignments)<>1 then raise exception 'own safe assignment missing'; end if;
 if exists(select 1 from job_assignments) then raise exception 'base assignment pay exposed'; end if;
 if exists(select 1 from information_schema.columns where table_name='client_visit_assignments' and column_name in ('payout_cents','offer_id')) then raise exception 'private assignment fields in client view'; end if;
end $$;
select respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000001',false,'Please arrange another cleaner',null);
reset role;
do $$ begin
 begin
  perform start_job('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002');
  raise exception 'declined backup started';
 exception when sqlstate 'PBC01' then null; end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000002',true,'', '98000000-0000-0000-0000-000000000001');
-- Idempotent response does not append another event or alter the prior decision.
select respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000002',true,'', '98000000-0000-0000-0000-000000000001');
do $$ begin
 if (select count(*) from visit_backup_decisions)<>2 then raise exception 'backup retry duplicated decision'; end if;
 if not (select approved from visit_backup_status limit 1) then raise exception 'approval not reflected'; end if;
 begin
  perform respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000003',false,'Stale decline', '98000000-0000-0000-0000-000000000001');
  raise exception 'stale backup response overwrote approval';
 exception when serialization_failure then null; end;
end $$;
reset role;
-- A changed visit owner must not inherit the former client's consent.
update jobs set customer_id='92000000-0000-0000-0000-000000000002' where id='95000000-0000-0000-0000-000000000001';
do $$ begin
 begin
  perform start_job('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002');
  raise exception 'new client inherited former client backup approval';
 exception when sqlstate 'PBC01' then null; end;
end $$;
update jobs set customer_id='92000000-0000-0000-0000-000000000001' where id='95000000-0000-0000-0000-000000000001';
-- Mutating a cleaner on the same assignment ID must not inherit the consent.
update job_assignments set cleaner_id='94000000-0000-0000-0000-000000000003' where id='97000000-0000-0000-0000-000000000001';
do $$ begin
 begin
  perform start_job('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000003');
  raise exception 'replacement inherited another cleaner approval';
 exception when sqlstate 'PBC01' then null; end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 begin
  perform respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000005',true,'',null);
  raise exception 'stale screen approved a different cleaner on the same assignment';
 exception when serialization_failure then null; end;
end $$;
reset role;
update job_assignments set cleaner_id='94000000-0000-0000-0000-000000000002' where id='97000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000004',true);
set local role authenticated;
do $$ begin
 if not (select approved from visit_backup_status limit 1) then raise exception 'cleaner approval status missing'; end if;
 if exists(select 1 from visit_backup_decisions) then raise exception 'client private decision note exposed to cleaner'; end if;
 begin
  perform respond_my_visit_backup('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000004',true,'',null);
  raise exception 'cleaner approved own backup';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if not start_job('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002') then raise exception 'approved backup could not start'; end if;
 if (select status from jobs where id='95000000-0000-0000-0000-000000000001')<>'in_progress' then raise exception 'start not persisted'; end if;
end $$;
-- Second client: the office can release only an explicitly declined, current
-- unstarted single assignment. Audit/receipts survive; matching excludes it.
update jobs set preferred_cleaner_id='94000000-0000-0000-0000-000000000001',status='assigned'
 where id='95000000-0000-0000-0000-000000000002';
insert into job_assignments(id,job_id,cleaner_id,payout_cents) values
 ('97000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000002',8000);
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from client_visit_assignments where job_id='95000000-0000-0000-0000-000000000002') then raise exception 'client read another visit assignment'; end if;
 if exists(select 1 from visit_backup_status where job_id='95000000-0000-0000-0000-000000000002') then raise exception 'client read another backup'; end if;
 begin
  perform respond_my_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006',true,'',null);
  raise exception 'client approved another visit backup';
 exception when insufficient_privilege then null; end;
 begin
  update visit_backup_decisions set accepted=true;
  raise exception 'client directly changed backup approval';
 exception when insufficient_privilege then null; end;
 begin
  perform release_declined_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006');
  raise exception 'client released an assignment';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
 begin
  perform release_declined_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006');
  raise exception 'office released a backup without a client decline';
 exception when serialization_failure then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
set local role authenticated;
select respond_my_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006',false,'Another cleaner please',null);
reset role;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
set local role authenticated;
select release_declined_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006');
select release_declined_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006');
reset role;
do $$ begin
 if exists(select 1 from job_assignments where job_id='95000000-0000-0000-0000-000000000002') then raise exception 'declined backup assignment not released'; end if;
 if (select status from jobs where id='95000000-0000-0000-0000-000000000002')<>'scheduled' then raise exception 'visit not returned to matching'; end if;
 if (select count(*) from visit_backup_releases)<>1 then raise exception 'release retry duplicated audit'; end if;
 if (select assignment_key from visit_backup_decisions where id='98000000-0000-0000-0000-000000000006')<>'97000000-0000-0000-0000-000000000002' then raise exception 'release lost original assignment identity'; end if;
 if cleaner_is_eligible('94000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000002') then raise exception 'matching allowed declined backup'; end if;
 begin
  perform record_offer('95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000002',null,'open_board',1,0.4,8000,60,now()+interval '1 hour',false);
  raise exception 'declined backup received another offer';
 exception when check_violation then null; end;
 begin
  insert into job_assignments(job_id,cleaner_id,payout_cents) values('95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000002',8000);
  raise exception 'declined backup reassigned directly';
 exception when check_violation then null; end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
set local role authenticated;
-- Receipt retry after release returns the old decision and creates no new one.
select respond_my_visit_backup('95000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000006',false,'Another cleaner please',null);
reset role;
insert into job_assignments(id,job_id,cleaner_id,payout_cents) values
 ('97000000-0000-0000-0000-000000000003','95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000003',8000);
update jobs set status='assigned' where id='95000000-0000-0000-0000-000000000002';
do $$ begin
 begin
  perform start_job('95000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000003');
  raise exception 'new backup inherited old decision';
 exception when sqlstate 'PBC01' then null; end;
end $$;
set local role anon;
do $$ begin
 begin
  perform request_my_visit_cleaner('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000003','',null);
  raise exception 'anonymous request accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
