-- Disposable verification database only. All fixtures and outcomes roll back.
begin;
insert into auth.users(id,email) values
 ('e9200000-0000-4000-8000-000000000001','offer-reader-a@example.test'),
 ('e9200000-0000-4000-8000-000000000002','offer-reader-b@example.test'),
 ('e9200000-0000-4000-8000-000000000003','offer-reader-client@example.test'),
 ('e9200000-0000-4000-8000-000000000004','offer-reader-admin@example.test');
update public.profiles set role='cleaner' where id in
 ('e9200000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000002');
update public.profiles set role='admin' where id='e9200000-0000-4000-8000-000000000004';
insert into public.cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared) values
 ('e9210000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','Offer Reader A','contractor_1099','active',4.8,true),
 ('e9210000-0000-4000-8000-000000000002','e9200000-0000-4000-8000-000000000002','Offer Reader B','contractor_1099','active',4.8,true);
insert into public.customers(id,profile_id,first_name,last_name,phone,notes) values
 ('e9220000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000003','Offer Client','PRIVATE SURNAME','PRIVATE PHONE','PRIVATE CLIENT NOTES');
insert into public.properties(id,customer_id,street,city,zip,access_notes) values
 ('e9230000-0000-4000-8000-000000000001','e9220000-0000-4000-8000-000000000001','PRIVATE HOME ADDRESS','Dallas','75201','PRIVATE ACCESS NOTES');
insert into public.jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start,dispatch_channel)
select ('e9240000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'e9220000-0000-4000-8000-000000000001','e9230000-0000-4000-8000-000000000001',
 'dispatching','standard','one_time',987654,60,now()+make_interval(days=>n),'waterfall'
from generate_series(1,6)n;
insert into public.offers(job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,expires_at,is_exclusive)
select ('e9240000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=2 then 'e9210000-0000-4000-8000-000000000002'::uuid else 'e9210000-0000-4000-8000-000000000001'::uuid end,
 'waterfall',7000,7000,.35,60,case when n=3 then now()-interval '1 minute' else now()+interval '1 hour' end,true
from generate_series(1,6)n;
-- A direct schedule change leaves a superseded offer to filter, even before a sweep.
update public.jobs set scheduled_start=scheduled_start+interval '1 hour' where id='e9240000-0000-4000-8000-000000000004';
update public.jobs set status='canceled' where id='e9240000-0000-4000-8000-000000000005';
update public.jobs set scheduled_start=now()-interval '1 hour' where id='e9240000-0000-4000-8000-000000000006';
select set_config('request.jwt.claim.sub','e9200000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare r jsonb;begin
 if exists(select 1 from public.jobs where id='e9240000-0000-4000-8000-000000000001') then raise exception 'Unassigned waterfall job RLS was widened';end if;
 select jsonb_agg(to_jsonb(o)) into r from public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000001')o;
 if jsonb_array_length(r)<>1 or r->0->>'job_id'<>'e9240000-0000-4000-8000-000000000001'
 or (r->0->>'payout_cents')::integer<>7000 or r->0->'jobs'->'properties'->>'city'<>'Dallas'
 or r->0->'jobs'->'customers'->>'first_name'<>'Offer Client' then raise exception 'Own actionable offer missing or another/stale offer exposed';end if;
 if r::text like '%PRIVATE%' or r::text like '%987654%' or r::text like '%street%' or r::text like '%zip%'
 or r::text like '%hourly_rate%' or r::text like '%payout_pct%' or r::text like '%tier%'
 then raise exception 'Private home, client price or ladder exposed';end if;
 begin perform public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000002');raise exception 'Another cleaner read allowed';exception when insufficient_privilege then null;end;
 begin perform public.read_my_live_job_offers(null);raise exception 'Null cleaner read allowed';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','e9200000-0000-4000-8000-000000000003',true);
 begin perform public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000001');raise exception 'Client read allowed';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','e9200000-0000-4000-8000-000000000004',true);
 begin perform public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000001');raise exception 'Office used cleaner-only projection';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','',true);
 begin perform public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000001');raise exception 'Missing session read allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.read_my_live_job_offers(uuid)','execute')
 or has_function_privilege('service_role','public.read_my_live_job_offers(uuid)','execute') then raise exception 'RPC execute privileges widened';end if;
end $$;
-- Accepted history is no longer a decision. No offer/assignment write is made by a read.
update public.offers set status='accepted' where job_id='e9240000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','e9200000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from public.read_my_live_job_offers('e9210000-0000-4000-8000-000000000001')) then raise exception 'Accepted offer still actionable';end if;
 raise notice 'Cleaner offer projection: unassigned waterfall visibility, privacy, stale offers and role isolation passed';
end $$;
rollback;
