-- Disposable verifier only. Scope expiration cannot answer another visit or
-- erase historical acceptance/pay. All fixtures roll back.
begin;
insert into customers(id,first_name,last_name) values('e1100000-0000-4000-8000-000000000001','Synthetic','Matching');
insert into properties(id,customer_id,street,city,zip) values('e1200000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001','Synthetic Matching Way','Dallas','75201');
insert into cleaners(id,full_name,type,status,rating,background_check_cleared) values('e1300000-0000-4000-8000-000000000001','Synthetic Matching Cleaner','contractor_1099','active',5,true);
insert into jobs(id,customer_id,property_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes)
 select ('e1400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'e1100000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001','scheduled','standard','one_time',now()+interval '30 days',19900,120 from generate_series(1,2)n;
insert into offers(id,job_id,cleaner_id,channel,hourly_rate_cents,payout_cents,payout_pct,estimated_minutes,status,expires_at)
 values
 ('e1500000-0000-4000-8000-000000000001','e1400000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','open_board',3000,6000,0.3,120,'sent',now()-interval '1 minute'),
 ('e1500000-0000-4000-8000-000000000002','e1400000-0000-4000-8000-000000000002','e1300000-0000-4000-8000-000000000001','open_board',3000,6000,0.3,120,'sent',now()-interval '1 minute'),
 ('e1500000-0000-4000-8000-000000000003','e1400000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','open_board',3000,6000,0.3,120,'accepted',now()-interval '2 minutes');
do $$ begin
 if has_function_privilege('anon','public.expire_stale_offers_for_job(uuid)','execute') or has_function_privilege('authenticated','public.expire_stale_offers_for_job(uuid)','execute') then raise exception 'Scoped server expiration exposed';end if;
end $$;
set local role service_role;
do $$ begin
 if expire_stale_offers_for_job('e1400000-0000-4000-8000-000000000001')<>1 then raise exception 'Scoped expiration count wrong';end if;
 if expire_stale_offers_for_job('e1400000-0000-4000-8000-000000000001')<>0 then raise exception 'Expiration retry changed result';end if;
 begin perform expire_stale_offers_for_job(null);raise exception 'Missing visit accepted';exception when sqlstate '22023' then null;end;
 raise notice 'Client booking matching: scoped expiration, retry, accepted pay and access passed';
end $$;
reset role;
do $$ begin
 if (select status from offers where id='e1500000-0000-4000-8000-000000000002')<>'sent' then raise exception 'Foreign visit expired';end if;
 if (select status from offers where id='e1500000-0000-4000-8000-000000000003')<>'accepted' or (select payout_cents from offers where id='e1500000-0000-4000-8000-000000000003')<>6000 then raise exception 'Historical acceptance/pay changed';end if;
end $$;
rollback;
