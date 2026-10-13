create table spotless_private.matching_worker_state (
  id boolean primary key default true check(id),
  run_id uuid,
  leased_until timestamptz not null default '-infinity',
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text not null default 'idle' check(last_status in ('idle','running','success','failed')),
  last_result jsonb not null default '{}'::jsonb
);
alter table spotless_private.matching_worker_state enable row level security;
revoke all on spotless_private.matching_worker_state from public,anon,authenticated,service_role;
insert into spotless_private.matching_worker_state(id) values(true);
create function public.claim_matching_worker(p_id uuid,p_seconds integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_id is null or p_seconds is null or p_seconds<30 or p_seconds>300 then raise exception 'invalid worker lease' using errcode='22023';end if;
 update spotless_private.matching_worker_state set run_id=p_id,leased_until=clock_timestamp()+make_interval(secs=>p_seconds),last_started_at=clock_timestamp(),last_finished_at=null,last_status='running',last_result='{}'
 where id and leased_until<=clock_timestamp();
 return found;
end $$;
create function public.finish_matching_worker(p_id uuid,p_status text,p_result jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_id is null or p_status not in ('success','failed') or p_status is null or p_result is null or jsonb_typeof(p_result)<>'object'
 or (p_result-array['jobs','expiredOffers','assigned','needsScheduling','held','offered','notified','deferred','unreachable','refused','unfilled','pushed','failed'])<>'{}'::jsonb
 or exists(select 1 from jsonb_each(p_result) x where jsonb_typeof(x.value)<>'number' or x.value::text!~'^[0-9]+$') then raise exception 'invalid worker result' using errcode='22023';end if;
 update spotless_private.matching_worker_state set leased_until=clock_timestamp(),last_finished_at=clock_timestamp(),last_status=p_status,last_result=p_result
 where id and run_id=p_id and last_status='running';
 return found;
end $$;
revoke all on function public.claim_matching_worker(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.finish_matching_worker(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.claim_matching_worker(uuid,integer) to service_role;
grant execute on function public.finish_matching_worker(uuid,text,jsonb) to service_role;
