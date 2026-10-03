-- Disposable verifier database only. No live identities or provider calls.
begin;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated;
grant select on profiles,customers,properties,jobs,job_assignments,cleaners to authenticated;
insert into auth.users(id,email) select ('c7100000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'crew-'||n||'@example.test' from generate_series(1,10)n;
update profiles set role=case when right(id::text,12)::integer=1 then 'admin'::user_role when right(id::text,12)::integer in (2,3) then 'customer'::user_role else 'cleaner'::user_role end where id::text like 'c7100000-%';
insert into customers(id,profile_id,first_name,last_name) values('c7200000-0000-0000-0000-000000000001','c7100000-0000-0000-0000-000000000002','Crew','Client');
insert into properties(id,customer_id,street,city,zip,gate_code,access_notes) values('c7300000-0000-0000-0000-000000000001','c7200000-0000-0000-0000-000000000001','Private Crew Home','Dallas','75001','PRIVATE-GATE','PRIVATE-ACCESS');
insert into cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared,hourly_rate_cents,guaranteed_hours_per_week)
 select ('c7400000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,('c7100000-0000-0000-0000-'||lpad((n+3)::text,12,'0'))::uuid,'Crew Cleaner '||n,
 case when n=5 then 'w2_core'::cleaner_type else 'contractor_1099'::cleaner_type end,'active',case when n=6 then 3.8 else 4.5 end,true,
 case when n=5 then 2175 end,case when n=5 then 30 end from generate_series(1,7)n;
insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start,preferred_cleaner_id)
 select ('c7500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'c7200000-0000-0000-0000-000000000001','c7300000-0000-0000-0000-000000000001',
 'scheduled','standard','one_time',24000,90,'2028-01-03 15:00Z'::timestamptz+make_interval(days=>n),'c7400000-0000-0000-0000-000000000001' from generate_series(1,11)n;
-- An actual accepted normal offer is preserved as withdrawn history, not deleted.
select respond_to_offer_with_capacity(record_offer('c7500000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000002',null,'open_board',1,0.3333,8000,90,clock_timestamp()+interval '1 hour',false),'c7400000-0000-0000-0000-000000000002',true);
insert into job_assignments(job_id,cleaner_id,is_lead,payout_cents)
 select id,'c7400000-0000-0000-0000-000000000002',true,8000 from jobs where id::text like 'c7500000-%' and right(id::text,12)::integer>1;
insert into job_assignments(job_id,cleaner_id,is_lead,payout_cents)
 select id,'c7400000-0000-0000-0000-000000000003',false,5100 from jobs where id::text like 'c7500000-%';
update jobs set status='assigned' where id::text like 'c7500000-%';
insert into visit_backup_decisions(id,job_id,assignment_id,assignment_key,customer_id,preferred_cleaner_id,backup_cleaner_id,accepted,note,decided_by)
 select ('c7800000-0000-0000-0000-'||right(a.job_id::text,12))::uuid,a.job_id,a.id,a.id,'c7200000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000001',a.cleaner_id,false,'PRIVATE-CLIENT-NOTE','c7100000-0000-0000-0000-000000000002'
 from job_assignments a where a.job_id::text like 'c7500000-%' and a.is_lead;
create temporary table crew_test_saved(n integer primary key,quote jsonb,assistant jsonb);
grant all on crew_test_saved to authenticated;
insert into crew_test_saved(n,assistant) select right(a.job_id::text,12)::integer,to_jsonb(a) from job_assignments a where a.job_id::text like 'c7500000-%' and not a.is_lead;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ declare review jsonb; begin
 review:=read_crew_lead_review('c7500000-0000-0000-0000-000000000001');
 if review->>'canReplace'<>'true' or jsonb_array_length(review->'crew')<>2 then raise exception 'Crew review missing';end if;
 if exists(select 1 from jsonb_array_elements(review->'candidates')c where c->>'id' in ('c7400000-0000-0000-0000-000000000002','c7400000-0000-0000-0000-000000000003','c7400000-0000-0000-0000-000000000006')) then raise exception 'Current crew or low-rated candidate listed';end if;
 begin perform quote_crew_lead_replacement('c7500000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000003');raise exception 'Assistant promoted out of accepted agreement';exception when check_violation then null;end;
end $$;
update crew_test_saved set quote=quote_crew_lead_replacement('c7500000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000004') where n=1;
select confirm_crew_lead_replacement((select (quote->>'id')::uuid from crew_test_saved where n=1));
select confirm_crew_lead_replacement((select (quote->>'id')::uuid from crew_test_saved where n=1));
reset role;
do $$ begin
 if (select count(*) from job_assignments where job_id='c7500000-0000-0000-0000-000000000001')<>2 or not exists(select 1 from job_assignments where job_id='c7500000-0000-0000-0000-000000000001' and cleaner_id='c7400000-0000-0000-0000-000000000002') then raise exception 'Sending offer removed original lead';end if;
 begin perform start_job('c7500000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000003');raise exception 'Crew started while replacement pending';exception when sqlstate 'PBC01' then null;end;
end $$;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000010',true);
set local role authenticated;
do $$ begin
 if read_my_crew_lead_offers()<>'[]'::jsonb then raise exception 'Another cleaner saw proposal';end if;
 begin perform respond_my_crew_lead_offer((select (quote->>'id')::uuid from crew_test_saved where n=1),true);raise exception 'Another cleaner accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
set local role authenticated;
do $$ declare r jsonb;begin
 r:=read_my_crew_lead_offers();
 if jsonb_array_length(r)<>1 or r::text like '%PRIVATE-%' or r::text like '%5100%' or r::text like '%reviewCrew%' then raise exception 'Offer leaked another agreement or home/client notes';end if;
 if exists(select 1 from jobs where id='c7500000-0000-0000-0000-000000000001') or exists(select 1 from properties where id='c7300000-0000-0000-0000-000000000001') then raise exception 'Unassigned candidate read private home';end if;
 begin perform read_crew_lead_review('c7500000-0000-0000-0000-000000000001');raise exception 'Cleaner read management crew pay';exception when insufficient_privilege then null;end;
 r:=respond_my_crew_lead_offer((select (quote->>'id')::uuid from crew_test_saved where n=1),true);
 if r->>'state'<>'accepted' or (r->>'payoutCents')::integer<>8000 or r->>'needsClientApproval'<>'true' then raise exception 'Wrong replacement agreement';end if;
 if r is distinct from respond_my_crew_lead_offer((r->>'id')::uuid,true) then raise exception 'Acceptance retry changed receipt';end if;
 begin perform respond_my_crew_lead_offer((r->>'id')::uuid,false);raise exception 'Saved accept flipped to decline';exception when sqlstate 'PT409' then null;end;
end $$;
reset role;
do $$ begin
 if (select to_jsonb(a) from job_assignments a where a.job_id='c7500000-0000-0000-0000-000000000001' and not a.is_lead) is distinct from (select assistant from crew_test_saved where n=1) then raise exception 'Teammate agreement changed';end if;
 if (select count(*) from crew_lead_releases)<>1 or (select count(*) from job_assignments where job_id='c7500000-0000-0000-0000-000000000001')<>2 then raise exception 'Duplicate acceptance/release or crew shrank';end if;
 if not exists(select 1 from offers where job_id='c7500000-0000-0000-0000-000000000001' and status='withdrawn') then raise exception 'Outgoing accepted offer history lost';end if;
 if exists(select 1 from visit_backup_status where job_id='c7500000-0000-0000-0000-000000000001' and (approved or decision_id is not null)) then raise exception 'Old client decision inherited';end if;
 begin update jobs set status='in_progress' where id='c7500000-0000-0000-0000-000000000001';raise exception 'Replacement skipped client approval';exception when sqlstate 'PBC01' then null;end;
end $$;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000003',true);
set local role authenticated;
do $$ begin
 begin perform respond_my_visit_backup('c7500000-0000-0000-0000-000000000001',(select id from job_assignments where job_id='c7500000-0000-0000-0000-000000000001' and is_lead),'c7400000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000004',public.uuid_generate_v4(),true,'',null);raise exception 'Other client approved';exception when insufficient_privilege then null;end;
 if exists(select 1 from crew_lead_releases) then raise exception 'Client read cleaner release';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select respond_my_visit_backup('c7500000-0000-0000-0000-000000000001',(select id from client_visit_assignments where job_id='c7500000-0000-0000-0000-000000000001' and is_lead),'c7400000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000004',public.uuid_generate_v4(),true,'',null);
reset role;
select start_job('c7500000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000004');
-- Employee and requested-cleaner replacements, with the same retained crew.
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',true);
set local role authenticated;
update crew_test_saved set quote=quote_crew_lead_replacement(('c7500000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 case when n=2 then 'c7400000-0000-0000-0000-000000000005'::uuid when n=3 then 'c7400000-0000-0000-0000-000000000001' else 'c7400000-0000-0000-0000-000000000004' end) where n>1;
select confirm_crew_lead_replacement((quote->>'id')::uuid) from crew_test_saved where n in (2,3,4,6,7,8,9,11);
reset role;
do $$ begin
 if (select state from spotless_private.crew_lead_proposals where id=(select (quote->>'id')::uuid from crew_test_saved where n=2))<>'accepted'
 or (select payout_cents from job_assignments where job_id='c7500000-0000-0000-0000-000000000002' and is_lead)<>0
 or (select hourly_rate_cents from cleaners where id='c7400000-0000-0000-0000-000000000005')<>2175 then raise exception 'Employee fee copied from outgoing contractor';end if;
 begin perform start_job('c7500000-0000-0000-0000-000000000002','c7400000-0000-0000-0000-000000000005');raise exception 'Employee backup started without client approval';exception when sqlstate 'PBC01' then null;end;
 -- A changed retained agreement invalidates a reviewed proposal.
 update job_assignments set payout_cents=5200 where job_id='c7500000-0000-0000-0000-000000000005' and not is_lead;
 -- Candidate becomes busy after the office sent the offer.
 insert into jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
 values('c7500000-0000-0000-0000-000000000099','c7200000-0000-0000-0000-000000000001','c7300000-0000-0000-0000-000000000001','assigned','standard','one_time',24000,90,'2028-01-11 15:00Z');
 insert into job_assignments(job_id,cleaner_id,payout_cents) values('c7500000-0000-0000-0000-000000000099','c7400000-0000-0000-0000-000000000004',8000);
 update jobs set status='canceled' where id='c7500000-0000-0000-0000-000000000007';
 update spotless_private.crew_lead_proposals set expires_at=clock_timestamp()-interval '1 second' where id=(select (quote->>'id')::uuid from crew_test_saved where n=9);
end $$;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 if confirm_crew_lead_replacement((select (quote->>'id')::uuid from crew_test_saved where n=5))->>'state'<>'withdrawn' then raise exception 'Stale teammate pay accepted';end if;
end $$;
reset role;
-- A fresh client approval of the original lead withdraws the pending offer.
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select respond_my_visit_backup('c7500000-0000-0000-0000-000000000006',(select id from client_visit_assignments where job_id='c7500000-0000-0000-0000-000000000006' and is_lead),'c7400000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000002',public.uuid_generate_v4(),true,'','c7800000-0000-0000-0000-000000000006');
select confirm_my_visit_reschedule('c7500000-0000-0000-0000-000000000011',(quote_my_visit_reschedule_with_fee('c7500000-0000-0000-0000-000000000011',(((clock_timestamp() at time zone 'America/Chicago')::date+30+time '12:00') at time zone 'America/Chicago'))->>'id')::uuid);
reset role;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000004',true);
set local role authenticated;
do $$ begin
 if respond_my_crew_lead_offer((select (quote->>'id')::uuid from crew_test_saved where n=3),true)->>'needsClientApproval'<>'false' then raise exception 'Requested cleaner treated as backup';end if;
end $$;
reset role;
select start_job('c7500000-0000-0000-0000-000000000003','c7400000-0000-0000-0000-000000000001');
-- The employee's exact assignment also becomes startable only after approval.
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000002',true);
set local role authenticated;
select respond_my_visit_backup('c7500000-0000-0000-0000-000000000002',(select id from client_visit_assignments where job_id='c7500000-0000-0000-0000-000000000002' and is_lead),'c7400000-0000-0000-0000-000000000001','c7400000-0000-0000-0000-000000000005',public.uuid_generate_v4(),true,'',null);
reset role;
select start_job('c7500000-0000-0000-0000-000000000002','c7400000-0000-0000-0000-000000000005');
-- A saved availability week with no matching day invalidates the offer.
insert into cleaner_availability(cleaner_id,day_of_week,starts_at,ends_at) values('c7400000-0000-0000-0000-000000000004',0,'08:00','09:00');
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000007',true);
set local role authenticated;
do $$ declare r jsonb;begin
 for r in select jsonb_build_object('n',n,'id',quote->>'id') from crew_test_saved where n in (4,6,7,8,9,11) loop
 if respond_my_crew_lead_offer((r->>'id')::uuid,true)->>'state' <> (case (r->>'n')::integer when 4 then 'conflict' when 8 then 'conflict' when 9 then 'expired' else 'withdrawn' end) then raise exception 'Stale/expired/unavailable offer accepted: %',r;end if;
 end loop;
end $$;
reset role;
delete from cleaner_availability where cleaner_id='c7400000-0000-0000-0000-000000000004';
-- Explicit withdrawal is idempotent and does not release anybody.
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000001',true);
set local role authenticated;
select confirm_crew_lead_replacement((select (quote->>'id')::uuid from crew_test_saved where n=10));
select withdraw_crew_lead_offer((select (quote->>'id')::uuid from crew_test_saved where n=10));
select withdraw_crew_lead_offer((select (quote->>'id')::uuid from crew_test_saved where n=10));
reset role;
do $$ declare f record;begin
 if (select count(*) from crew_lead_releases)<>3 then raise exception 'Failed offers released crews';end if;
 if exists(select 1 from crew_test_saved s join job_assignments a on a.job_id=('c7500000-0000-0000-0000-'||lpad(s.n::text,12,'0'))::uuid and not a.is_lead where s.n not in (5,11) and to_jsonb(a) is distinct from s.assistant) then raise exception 'Retained agreements mutated';end if;
 if exists(select 1 from invoices where customer_id='c7200000-0000-0000-0000-000000000001') then raise exception 'Replacement automatically charged client';end if;
 if not (select relrowsecurity from pg_class where oid='spotless_private.crew_lead_proposals'::regclass) or has_schema_privilege('authenticated','spotless_private','USAGE') then raise exception 'Private snapshots exposed';end if;
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('read_crew_lead_review','quote_crew_lead_replacement','confirm_crew_lead_replacement','withdraw_crew_lead_offer','read_my_crew_lead_offers','respond_my_crew_lead_offer') loop
 if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('service_role',f.oid,'EXECUTE') or not has_function_privilege('authenticated',f.oid,'EXECUTE') then raise exception 'Crew RPC grants wrong';end if;
 end loop;
 raise notice 'Crew lead replacement: exact acceptance, retained agreements, fresh client approval, employee terms, requested cleaner, stale decisions/visits/availability, safe reads and retries verified';
end $$;
-- Historical acceptance remains a receipt, never a current booking claim.
update jobs set status='canceled' where id='c7500000-0000-0000-0000-000000000002';
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000008',true);
set local role authenticated;
do $$ declare r jsonb;begin
 r:=read_my_crew_lead_offers()->0;
 if r->>'state'<>'accepted' or r->>'assignmentCurrent'<>'false' then raise exception 'Old employee acceptance falsely confirmed current assignment';end if;
end $$;
reset role;
-- Only the released lead sees their own release notice.
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000005',true);
set local role authenticated;
do $$ begin if (select count(*) from crew_lead_releases)<>3 then raise exception 'Own removed-lead notices missing';end if;end $$;
reset role;
select set_config('request.jwt.claim.sub','c7100000-0000-0000-0000-000000000006',true);
set local role authenticated;
do $$ begin if exists(select 1 from crew_lead_releases) then raise exception 'Retained teammate read another cleaner release';end if;end $$;
reset role;
rollback;
