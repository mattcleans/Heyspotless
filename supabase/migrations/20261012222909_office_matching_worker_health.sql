-- Office reads saved scheduler/worker outcomes without transport or credentials.
create function public.office_matching_worker_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_worker jsonb;v_count integer:=0;v_enabled boolean:=false;v_expected boolean:=false;
 v_job bigint;v_scheduler_status text;v_scheduler_start timestamptz;v_scheduler_end timestamptz;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','manager'))
 then raise exception 'Office access required' using errcode='42501';end if;
 select to_jsonb(s) into v_worker from spotless_private.matching_worker_state s where s.id;
 if to_regclass('cron.job') is not null then
  execute $cron$ select count(*)::integer,coalesce(bool_and(active),false),coalesce(bool_and(schedule='*/5 * * * *'),false),min(jobid)
   from cron.job where jobname in ('heyspotless-matching-preview','heyspotless-matching')
   and command='select spotless_private.invoke_matching_worker();' and username='postgres' $cron$
  into v_count,v_enabled,v_expected,v_job;
  if v_count=1 and to_regclass('cron.job_run_details') is not null then
   execute 'select status,start_time,end_time from cron.job_run_details where jobid=$1 order by runid desc limit 1'
   into v_scheduler_status,v_scheduler_start,v_scheduler_end using v_job;
  end if;
 end if;
 return jsonb_build_object('observed_at',clock_timestamp(),'state_present',v_worker is not null,
  'scheduler_count',v_count,'scheduler_enabled',v_enabled,'expected_interval',v_expected,
  'scheduler_status',v_scheduler_status,'scheduler_started_at',v_scheduler_start,'scheduler_finished_at',v_scheduler_end,
  'last_status',v_worker->>'last_status','last_started_at',v_worker->'last_started_at',
  'last_finished_at',v_worker->'last_finished_at','leased_until',v_worker->'leased_until',
  'last_result',jsonb_build_object('jobs',v_worker->'last_result'->'jobs','assigned',v_worker->'last_result'->'assigned',
   'offered',v_worker->'last_result'->'offered','needsScheduling',v_worker->'last_result'->'needsScheduling','failed',v_worker->'last_result'->'failed'));
end $$;
revoke all on function public.office_matching_worker_health() from public,anon,authenticated,service_role;
grant execute on function public.office_matching_worker_health() to authenticated;
