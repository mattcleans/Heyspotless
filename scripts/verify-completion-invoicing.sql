-- Disposable synthetic fixtures; all records roll back.
begin;
do $$
declare
  v_customer uuid; v_property uuid; v_cleaner uuid; v_other uuid;
  v_job uuid; v_invoice uuid; v_completed timestamptz; v_count integer;
  n integer; room text;
begin
  insert into customers(first_name,last_name) values('SYNTHETIC','Invoice order test') returning id into v_customer;
  insert into properties(customer_id,street,city,zip,bedrooms,bathrooms,utility_rooms)
    values(v_customer,'SYNTHETIC PREVIEW ONLY','Dallas','75201',1,1,0) returning id into v_property;
  insert into cleaners(full_name,type,status,rating,background_check_cleared)
    values('SYNTHETIC Assigned','contractor_1099','active',4.8,true) returning id into v_cleaner;
  insert into cleaners(full_name,type,status,rating,background_check_cleared)
    values('SYNTHETIC Other','contractor_1099','active',4.8,true) returning id into v_other;
  for n in 1..3 loop
    insert into jobs(customer_id,property_id,status,service,freq,scheduled_start,price_cents,estimated_clean_minutes)
      values(v_customer,v_property,'assigned','standard','one_time',now()-interval '2 hours',19900,120) returning id into v_job;
    insert into job_assignments(job_id,cleaner_id,payout_cents) values(v_job,v_cleaner,6965);
    perform start_job(v_job,v_cleaner);
    foreach room in array array['kitchen_1','bathroom_1','living_room_1','bedroom_1'] loop
      perform record_job_photo(v_job,v_cleaner,'synthetic/'||v_job||'/'||room||'/before','before',room);
      if n<>2 or room<>'bedroom_1' then
        perform record_job_photo(v_job,v_cleaner,'synthetic/'||v_job||'/'||room||'/after','after',room);
      end if;
    end loop;
    if exists(select 1 from invoices where job_id=v_job) then raise exception 'In-progress visit invoiced'; end if;
    -- Emulate an already completed visit affected by the old implementation.
    if n=3 then update jobs set status='complete',completed_at=now()-interval '1 hour' where id=v_job; end if;
    if complete_job(v_job,v_other) then raise exception 'Unassigned Cleaner completed visit'; end if;
    if exists(select 1 from invoices where job_id=v_job) then raise exception 'Unassigned completion invoiced visit'; end if;
    if not complete_job(v_job,v_cleaner) then raise exception 'Assigned completion refused'; end if;
    select completed_at into v_completed from jobs where id=v_job;
    if n=2 then
      if exists(select 1 from invoices where job_id=v_job) then raise exception 'Missing after photo did not block billing'; end if;
      perform record_job_photo(v_job,v_cleaner,'synthetic/'||v_job||'/bedroom_1/after','after','bedroom_1');
    end if;
    select id into v_invoice from invoices where job_id=v_job;
    if v_invoice is null then raise exception 'Invoice missing for ordering %',n; end if;
    if not exists(select 1 from invoices where id=v_invoice and total_cents=19900 and subtotal_cents=19900) then raise exception 'Invoice changed agreed job price'; end if;
    if not exists(select 1 from jobs where id=v_job and status='complete' and invoiced_at is not null) then raise exception 'Invoice timestamp or completion missing'; end if;
    perform complete_job(v_job,v_cleaner);
    perform record_job_photo(v_job,v_cleaner,'synthetic/retry','after','bedroom_1');
    select count(*) into v_count from invoices where job_id=v_job;
    if v_count<>1 or (select completed_at from jobs where id=v_job) is distinct from v_completed then raise exception 'Retry duplicated invoice or moved completion'; end if;
  end loop;
  if has_function_privilege('anon','public.complete_job(uuid,uuid,numeric,numeric)','execute')
     or has_function_privilege('authenticated','public.complete_job(uuid,uuid,numeric,numeric)','execute')
     or not has_function_privilege('service_role','public.complete_job(uuid,uuid,numeric,numeric)','execute')
  then raise exception 'Completion execution grants changed'; end if;
  raise notice 'Invoice ordering: photos before Done, photos after Done, legacy retry, price and assignment isolation passed';
end $$;
rollback;
