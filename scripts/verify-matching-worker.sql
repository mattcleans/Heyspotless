begin;
do $$ begin
 if has_function_privilege('anon','public.claim_matching_worker(uuid,integer)','execute') or has_function_privilege('authenticated','public.finish_matching_worker(uuid,text,jsonb)','execute')
 or has_table_privilege('authenticated','spotless_private.matching_worker_state','select') then raise exception 'Worker control exposed';end if;
end $$;
set local role service_role;
do $$ begin
 if not claim_matching_worker('f1100000-0000-4000-8000-000000000001',180) then raise exception 'First lease refused';end if;
 if claim_matching_worker('f1100000-0000-4000-8000-000000000002',180) then raise exception 'Overlapping worker accepted';end if;
 if finish_matching_worker('f1100000-0000-4000-8000-000000000002','success','{"offered":1}') then raise exception 'Foreign lease finished';end if;
 begin perform finish_matching_worker('f1100000-0000-4000-8000-000000000001','success','{"secret":"not allowed"}');raise exception 'Private result accepted';exception when sqlstate '22023' then null;end;
 if not finish_matching_worker('f1100000-0000-4000-8000-000000000001','failed','{"failed":1}') then raise exception 'Failure not recorded';end if;
 if finish_matching_worker('f1100000-0000-4000-8000-000000000001','success','{"failed":0}') then raise exception 'Terminal run rewritten';end if;
 if not claim_matching_worker('f1100000-0000-4000-8000-000000000002',180) then raise exception 'Recovery run refused';end if;
end $$;
reset role;
update spotless_private.matching_worker_state set leased_until=clock_timestamp()-interval '1 second';
set local role service_role;
do $$ begin
 if not claim_matching_worker('f1100000-0000-4000-8000-000000000003',180) then raise exception 'Expired lease did not recover';end if;
 if finish_matching_worker('f1100000-0000-4000-8000-000000000002','success','{}') then raise exception 'Older run overwrote new lease';end if;
 if not finish_matching_worker('f1100000-0000-4000-8000-000000000003','success','{"jobs":0}') then raise exception 'Current lease not finished';end if;
 raise notice 'Matching worker lease: overlap, failure recovery, expiration and result privacy passed';
end $$;
rollback;
