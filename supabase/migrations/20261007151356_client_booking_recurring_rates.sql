-- Recurring self-service rates require an explicit repeating request.
-- Office quote terms remain independently reviewable and unchanged.
do $patch$
declare v_sql text;v_marker text;
begin
 select pg_get_functiondef('public.review_my_booking(uuid,uuid,public.service_type,public.frequency,timestamptz,boolean,jsonb,text)'::regprocedure) into v_sql;
 v_marker:=' if not isfinite(p_start)';
 if strpos(v_sql,v_marker)=0 then raise exception 'Owned review changed: review recurring rate guard';end if;
 v_sql:=replace(v_sql,v_marker,E' if p_repeats is distinct from (p_freq<>\'one_time\') then\n  raise exception \'Recurring rates require a repeating request\' using errcode=\'22023\';end if;\n'||v_marker);
 execute v_sql;
 select pg_get_functiondef('public.confirm_my_booking(uuid)'::regprocedure) into v_sql;
 v_marker:=' if r.expires_at<=clock_timestamp()';
 if strpos(v_sql,v_marker)=0 then raise exception 'Owned confirmation changed: review recurring rate guard';end if;
 v_sql:=replace(v_sql,v_marker,E' if r.repeats is distinct from (r.freq<>\'one_time\') then\n  raise exception \'Review the repeating choice again\' using errcode=\'PT409\';end if;\n'||v_marker);
 execute v_sql;
 select pg_get_functiondef('spotless_private.client_booking_view(uuid)'::regprocedure) into v_sql;
 v_marker:='  when r.home_snapshot is distinct from';
 if strpos(v_sql,v_marker)=0 then raise exception 'Owned receipt changed: review recurring rate guard';end if;
 v_sql:=replace(v_sql,v_marker,E'  when r.repeats is distinct from (r.freq<>\'one_time\') then \'stale\'\n'||v_marker);
 execute v_sql;
end $patch$;
