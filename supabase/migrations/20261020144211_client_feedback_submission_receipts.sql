-- A lost response must not make an older tip overwrite a later submission.
create table spotless_private.client_feedback_receipts (
 id uuid primary key,
 profile_id uuid not null references public.profiles(id),
 job_id uuid not null references public.jobs(id),
 payload jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now()
);
alter table spotless_private.client_feedback_receipts enable row level security;
revoke all on spotless_private.client_feedback_receipts from public,anon,authenticated,service_role;

create function public.record_client_visit_feedback_once(
 p_submission_id uuid,p_profile_id uuid,p_job_id uuid,p_score numeric,p_comment text,
 p_highlights text[],p_private_note text,p_tip_cents integer default 0
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 v_payload jsonb; v_saved spotless_private.client_feedback_receipts%rowtype; v_result jsonb;
begin
 if p_submission_id is null then raise invalid_parameter_value; end if;
 perform pg_advisory_xact_lock(hashtextextended('client_feedback:'||p_submission_id::text,0));
 -- Ownership is checked again even for a previously recorded response.
 perform 1 from public.jobs j join public.customers c on c.id=j.customer_id
  join public.profiles p on p.id=c.profile_id
  where j.id=p_job_id and p.id=p_profile_id and p.role='customer'
   and j.status='complete' for update of j;
 if not found then return jsonb_build_object('recorded',false); end if;
 v_payload:=jsonb_build_object('score',p_score,'comment',p_comment,'highlights',p_highlights,
  'privateNote',p_private_note,'tipCents',p_tip_cents);
 select * into v_saved from spotless_private.client_feedback_receipts where id=p_submission_id;
 if v_saved.id is not null then
  if v_saved.profile_id<>p_profile_id or v_saved.job_id<>p_job_id or v_saved.payload is distinct from v_payload then
   raise insufficient_privilege;
  end if;
  return v_saved.result;
 end if;
 v_result:=public.record_client_visit_feedback(p_profile_id,p_job_id,p_score,p_comment,p_highlights,p_private_note,p_tip_cents);
 if v_result->>'recorded'='true' then
  insert into spotless_private.client_feedback_receipts(id,profile_id,job_id,payload,result)
   values(p_submission_id,p_profile_id,p_job_id,v_payload,v_result);
 end if;
 return v_result;
end $$;
revoke all on function public.record_client_visit_feedback_once(uuid,uuid,uuid,numeric,text,text[],text,integer)
 from public,anon,authenticated;
grant execute on function public.record_client_visit_feedback_once(uuid,uuid,uuid,numeric,text,text[],text,integer)
 to service_role;
