-- Disposable schema verification; no client data or provider calls.
begin;
do $check$
declare
  v_signature text;
  v_function pg_proc%rowtype;
  v_pattern constant text := 'errcode[[:space:]]*=[[:space:]]*''PT409''';
begin
  foreach v_signature in array array[
    'public.confirm_my_recurring_schedule(uuid,uuid)',
    'public.confirm_my_visit_cancellation(uuid,uuid)',
    'public.confirm_my_visit_reschedule(uuid,uuid)',
    'public.materialise_recurring_job(uuid,date,timestamp with time zone)',
    'public.materialise_recurring_job_for_revision(uuid,date,timestamp with time zone,bigint)',
    'public.preview_recurring_edit(uuid,date,public.frequency,time without time zone,date,date,date)',
    'public.quote_my_visit_cancellation(uuid,text)',
    'public.quote_my_visit_reschedule(uuid,timestamp with time zone)',
    'public.release_declined_visit_backup(uuid,uuid,uuid,uuid,uuid)',
    'public.request_my_visit_cleaner(uuid,uuid,uuid,text,uuid)',
    'public.resolve_visit_cancellation_billing(uuid,uuid)',
    'public.respond_my_visit_backup(uuid,uuid,uuid,uuid,uuid,boolean,text,uuid)',
    'public.review_visit_cleaner_request(uuid,boolean,text)',
    'public.set_my_home_instructions(uuid,text,text,text,text,jsonb)',
    'public.skip_recurring_occurrence(uuid,date,text,uuid)',
    'public.stamp_cancellation_schedule()',
    'public.stamp_reschedule_epoch()'
  ] loop
    select * into strict v_function from pg_proc where oid=v_signature::regprocedure;
    if not (v_function.prosrc ~* v_pattern) then
      raise exception 'Stale review lacks HTTP conflict in %',v_signature;
    end if;
    if has_function_privilege('anon',v_function.oid,'EXECUTE') then
      raise exception 'Stale review exposed to anonymous callers in %',v_signature;
    end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosrc ~* 'errcode[[:space:]]*=[[:space:]]*''40001''') then
    raise exception 'Workflow still raises a custom serialization failure';
  end if;
  if (select prosecdef from pg_proc where oid='public.set_my_home_instructions(uuid,text,text,text,text,jsonb)'::regprocedure) then
    raise exception 'Home instruction ownership checks changed to security definer';
  end if;
  foreach v_signature in array array[
    'public.materialise_recurring_job(uuid,date,timestamp with time zone)',
    'public.materialise_recurring_job_for_revision(uuid,date,timestamp with time zone,bigint)',
    'public.preview_recurring_edit(uuid,date,public.frequency,time without time zone,date,date,date)',
    'public.skip_recurring_occurrence(uuid,date,text,uuid)',
    'public.stamp_cancellation_schedule()',
    'public.stamp_reschedule_epoch()'
  ] loop
    if has_function_privilege('authenticated',v_signature,'EXECUTE') then
      raise exception 'Internal workflow helper exposed to client callers in %',v_signature;
    end if;
  end loop;
  raise notice 'Stale reviews: 17 exact HTTP conflicts; anonymous/internal-helper grants protected';
end
$check$;
rollback;
