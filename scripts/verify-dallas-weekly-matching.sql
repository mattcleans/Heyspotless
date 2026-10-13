-- Disposable verification: all fictional actors and assignments roll back.
begin;
grant usage on schema public,auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant select on public.jobs,public.job_assignments,public.cleaners,public.properties to authenticated;
insert into auth.users(id,email) select ('dc110000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'weekly-matching-'||n||'@example.test' from generate_series(1,3)n;
update public.profiles set role=case right(id::text,12)::integer when 1 then 'cleaner'::user_role when 2 then 'admin'::user_role else 'customer'::user_role end where id::text like 'dc110000-%';
insert into public.customers(id,profile_id,first_name,last_name) values('dc120000-0000-4000-8000-000000000001','dc110000-0000-4000-8000-000000000003','Weekly','Client');
insert into public.properties(id,customer_id,street,city,zip) values('dc130000-0000-4000-8000-000000000001','dc120000-0000-4000-8000-000000000001','Synthetic weekly home','Dallas','75001');
insert into public.cleaners(id,profile_id,full_name,type,status,rating,background_check_cleared) values
 ('dc140000-0000-4000-8000-000000000001','dc110000-0000-4000-8000-000000000001','Weekly self','w2_core','active',4.5,true),
 ('dc140000-0000-4000-8000-000000000002',null,'Weekly other','w2_core','active',4.5,true);
insert into public.jobs(id,customer_id,property_id,status,service,freq,price_cents,estimated_clean_minutes,scheduled_start)
select ('dc150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'dc120000-0000-4000-8000-000000000001','dc130000-0000-4000-8000-000000000001',
 case when n=5 then 'canceled'::job_status else 'complete'::job_status end,'standard','one_time',20000,30,
 case n when 1 then '2027-03-15 04:30Z'::timestamptz when 2 then '2027-03-15 05:00Z'
 when 3 then '2027-11-08 05:30Z' when 4 then '2027-11-08 06:00Z' when 5 then '2027-03-15 06:00Z'
 when 6 then (date_trunc('week',now() at time zone 'America/Chicago')+interval '6 days 23 hours 30 minutes') at time zone 'America/Chicago'
 else '2027-03-15 07:00Z' end from generate_series(1,7)n;
insert into public.job_assignments(job_id,cleaner_id,payout_cents)
 select id,case when right(id::text,12)::integer=7 then 'dc140000-0000-4000-8000-000000000002'::uuid else 'dc140000-0000-4000-8000-000000000001'::uuid end,5000
 from public.jobs where id::text like 'dc150000-%';
do $week_check$
declare v numeric := .5; zone text;
begin
 if not exists(select 1 from pg_class where oid='public.cleaner_week_load_by_week'::regclass and reloptions @> array['security_invoker=true']) then raise exception 'Weekly view bypasses RLS';end if;
 if has_table_privilege('anon','public.cleaner_week_load_by_week','select') then raise exception 'Anonymous weekly load access widened';end if;
 foreach zone in array array['UTC','America/Chicago'] loop
  perform set_config('TimeZone',zone,true);
   if (select scheduled_clean_hours from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000001' and week_start='2027-03-08') is distinct from v
   or (select scheduled_clean_hours from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000001' and week_start='2027-03-15') is distinct from v
   or (select scheduled_clean_hours from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000001' and week_start='2027-11-01') is distinct from v
   or (select scheduled_clean_hours from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000001' and week_start='2027-11-08') is distinct from v then raise exception 'Dallas week boundary or canceled exclusion failed in %',zone;end if;
  -- Sunday night is already Monday UTC; it still belongs in the current Dallas week.
  if (select hours_scheduled_this_week from public.cleaner_week_load where cleaner_id='dc140000-0000-4000-8000-000000000001') is distinct from .5::numeric then raise exception 'Current Dallas week omitted Sunday night in %',zone;end if;
 end loop;
end $week_check$;
select set_config('request.jwt.claim.sub','dc110000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $self_check$ begin
 if not exists(select 1 from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000001') then raise exception 'Cleaner lost own weekly load';end if;
 if exists(select 1 from public.cleaner_week_load_by_week where cleaner_id='dc140000-0000-4000-8000-000000000002') then raise exception 'Cleaner saw another weekly load';end if;
end $self_check$;
reset role;
select set_config('request.jwt.claim.sub','dc110000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $admin_check$ begin
 if (select count(distinct cleaner_id) from public.cleaner_week_load_by_week where cleaner_id::text like 'dc140000-%')<>2 then raise exception 'Management cannot read saved weekly loads';end if;
end $admin_check$;
reset role;
select set_config('request.jwt.claim.sub','dc110000-0000-4000-8000-000000000003',true);
set local role authenticated;
do $client_check$ begin
 if exists(select 1 from public.cleaner_week_load_by_week where cleaner_id::text like 'dc140000-%') then raise exception 'Client saw Cleaner weekly loads';end if;
end $client_check$;
reset role;
do $done$ begin raise notice 'Dallas weekly loads: both DST boundaries, Sunday night, completed/canceled work, Management/self/Client isolation verified';end $done$;
rollback;
