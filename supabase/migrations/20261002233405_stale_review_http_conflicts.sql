-- Stale reviews are business conflicts, not retryable database failures.
-- PT409 maps directly to HTTP 409 in PostgREST. Reserve 40001 for genuine
-- PostgreSQL serialization failures; custom 40001 can loop in PostgREST 14.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
-- Rewrite only these exact workflow signatures. Existing migrations remain
-- immutable, and CREATE OR REPLACE preserves each function's owner and grants.
do $migration$
declare
  v_signature text;
  v_oid oid;
  v_before jsonb;
  v_after jsonb;
  v_definition text;
  v_before_defaults text;
  v_after_defaults text;
  v_pattern constant text := 'errcode[[:space:]]*=[[:space:]]*''40001''';
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
    v_oid := v_signature::regprocedure::oid;
    select to_jsonb(p),pg_get_expr(p.proargdefaults,0) into strict v_before,v_before_defaults from pg_proc p where p.oid=v_oid;
    if not (v_before->>'prosrc' ~* v_pattern) then
      raise exception 'Expected stale-review guard absent in %',v_signature;
    end if;
    v_definition := regexp_replace(pg_get_functiondef(v_oid),v_pattern,'errcode=''PT409''','gi');
    execute v_definition;
    select to_jsonb(p),pg_get_expr(p.proargdefaults,0) into strict v_after,v_after_defaults from pg_proc p where p.oid=v_oid;
    -- Re-parsing defaults may change internal source-location offsets.
    -- Compare their canonical SQL, while retaining strict catalog comparison
    -- for every other attribute (including ACL, owner and security settings).
    if (v_before-array['prosrc','proargdefaults']) is distinct from (v_after-array['prosrc','proargdefaults'])
       or v_before_defaults is distinct from v_after_defaults
       or v_after->>'prosrc' is distinct from
          regexp_replace(v_before->>'prosrc',v_pattern,'errcode=''PT409''','gi') then
      raise exception 'Unexpected function or privilege change in %',v_signature
        using detail=(select jsonb_agg(k.key)::text from jsonb_each(v_before) k
          where k.value is distinct from v_after->k.key); 
    end if;
  end loop;
end
$migration$;
