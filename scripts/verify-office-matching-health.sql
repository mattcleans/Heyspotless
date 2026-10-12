-- Disposable verification database only; no scheduler/network calls occur.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('e9100000-0000-4000-8000-000000000001','health-admin@example.test','{}'),
 ('e9100000-0000-4000-8000-000000000002','health-manager@example.test','{}'),
 ('e9100000-0000-4000-8000-000000000003','health-cleaner@example.test','{}'),
 ('e9100000-0000-4000-8000-000000000004','health-client@example.test','{"role":"admin"}');
update public.profiles set role='admin' where id='e9100000-0000-4000-8000-000000000001';
update public.profiles set role='manager' where id='e9100000-0000-4000-8000-000000000002';
update public.profiles set role='cleaner' where id='e9100000-0000-4000-8000-000000000003';
select set_config('request.jwt.claim.sub','e9100000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.office_matching_worker_health();
 if (r->>'scheduler_count')::integer<>0 then raise exception 'Absent scheduler invented';end if;
end $$;
reset role;
-- Real metadata queries are exercised against isolated Cron table fixtures.
create schema cron;
create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,username text,active boolean);
create table cron.job_run_details(runid bigint primary key,jobid bigint,status text,start_time timestamptz,end_time timestamptz);
insert into cron.job values(1,'heyspotless-matching-preview','*/5 * * * *','select spotless_private.invoke_matching_worker();','postgres',true);
insert into cron.job_run_details values(1,1,'succeeded',now()-interval '1 minute',now()-interval '59 seconds');
update spotless_private.matching_worker_state set last_status='success',last_started_at=now()-interval '1 minute',last_finished_at=now()-interval '59 seconds',leased_until=now()-interval '59 seconds',last_result='{"jobs":9,"assigned":0,"offered":0,"needsScheduling":9,"failed":0,"private_detail":"never return"}';
create temporary table health_worker_preserved as select to_jsonb(s) data from spotless_private.matching_worker_state s;
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.office_matching_worker_health();
 if (r->>'scheduler_count')::integer<>1 or (r->>'scheduler_enabled')::boolean is not true or r->>'scheduler_status'<>'succeeded'
 or (r->'last_result'->>'needsScheduling')::integer<>9 then raise exception 'Saved health not read';end if;
 if r ? 'run_id' or r ? 'token_hash' or r ? 'command' or r::text like '%private_detail%' then raise exception 'Private worker data exposed';end if;
 perform set_config('request.jwt.claim.sub','e9100000-0000-4000-8000-000000000002',true);
 if public.office_matching_worker_health()->>'last_status'<>'success' then raise exception 'Manager denied';end if;
 perform set_config('request.jwt.claim.sub','e9100000-0000-4000-8000-000000000003',true);
 begin perform public.office_matching_worker_health();raise exception 'Cleaner read worker health';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','e9100000-0000-4000-8000-000000000004',true);
 begin perform public.office_matching_worker_health();raise exception 'Client metadata granted Office access';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','',true);
 begin perform public.office_matching_worker_health();raise exception 'Unsigned caller read worker health';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.office_matching_worker_health()','execute') or has_function_privilege('service_role','public.office_matching_worker_health()','execute')
 or has_table_privilege('authenticated','spotless_private.matching_worker_state','select') then raise exception 'Worker privileges widened';end if;
 if exists(select 1 from health_worker_preserved p full join (select to_jsonb(s) data from spotless_private.matching_worker_state s) n on p.data=n.data where p.data is null or n.data is null) then raise exception 'Health read mutated worker state';end if;
end $$;
update cron.job set active=false;
select set_config('request.jwt.claim.sub','e9100000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ begin if (public.office_matching_worker_health()->>'scheduler_enabled')::boolean is not false then raise exception 'Paused scheduler called active';end if;end $$;
reset role;
update cron.job set active=true,schedule='0 * * * *';
update cron.job_run_details set status='failed';
set local role authenticated;
do $$ declare r jsonb;begin r:=public.office_matching_worker_health();if (r->>'expected_interval')::boolean is not false or r->>'scheduler_status'<>'failed' then raise exception 'Scheduler failure or changed interval hidden';end if;end $$;
reset role;
insert into cron.job values(2,'heyspotless-matching','*/5 * * * *','select spotless_private.invoke_matching_worker();','postgres',true);
set local role authenticated;
do $$ begin if (public.office_matching_worker_health()->>'scheduler_count')::integer<>2 then raise exception 'Duplicate schedule hidden';end if;end $$;
reset role;
update public.profiles set role='customer' where id='e9100000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin begin perform public.office_matching_worker_health();raise exception 'Revoked Office role retained access';exception when insufficient_privilege then null;end;raise notice 'Office matching health: real metadata, role denial, privacy and read-only behavior passed';end $$;
rollback;
