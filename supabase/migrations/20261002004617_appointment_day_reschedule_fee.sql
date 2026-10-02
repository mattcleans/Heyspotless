-- Corrected policy: $60 when changed on the Dallas appointment day to
-- another calendar day. A different time on that same day remains free.
-- Earlier-day changes are free, even inside 24 hours. No provider calls here.
alter table public.visit_reschedule_quotes
 add column fee_cents integer not null default 0 check(fee_cents in (0,6000));
alter table public.visit_reschedules drop constraint visit_reschedules_fee_cents_check;
alter table public.visit_reschedules
 add constraint visit_reschedules_fee_cents_check check(fee_cents in (0,6000)),
 add column invoice_id uuid unique references public.invoices(id),
 add constraint visit_reschedules_fee_invoice_check check(
  (fee_cents=0 and invoice_id is null) or (fee_cents=6000 and invoice_id is not null));
alter table public.invoices
 add column kind text not null default 'service' check(kind in ('service','reschedule_fee')),
 add constraint invoices_reschedule_fee_shape check(kind<>'reschedule_fee' or
  (job_id is null and subtotal_cents=6000 and total_cents=6000 and tip_cents=0));

create function public.visit_reschedule_fee(p_previous timestamptz,p_next timestamptz,p_now timestamptz)
 returns integer language sql immutable set search_path=public,pg_temp as $$
 select case when
  (p_previous at time zone 'America/Chicago')::date=(p_now at time zone 'America/Chicago')::date
  and (p_next at time zone 'America/Chicago')::date<>(p_previous at time zone 'America/Chicago')::date
 then 6000 else 0 end
$$;
revoke all on function public.visit_reschedule_fee(timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
-- Old reviews used the previous all-free policy. Require a fresh review.
update public.visit_reschedule_quotes set expires_at=least(expires_at,clock_timestamp());

create or replace function quote_my_visit_reschedule(p_job_id uuid,p_new_start timestamptz) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype; q visit_reschedule_quotes%rowtype; v_duration interval;
begin
 if not is_admin() and (current_role_of() is distinct from 'customer' or current_customer_id() is null) then raise insufficient_privilege; end if;
 select * into j from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id()) for update;
 if j.id is null then raise insufficient_privilege; end if;
 if j.status not in ('unscheduled','scheduled','dispatching','assigned') or j.started_at is not null
   or exists(select 1 from time_entries where job_id=j.id) then raise exception 'visit already started or closed' using errcode='40001'; end if;
 if p_new_start is null or not isfinite(p_new_start) or p_new_start<=clock_timestamp() or
  p_new_start>clock_timestamp()+interval '366 days' or date_trunc('minute',p_new_start)<>p_new_start or
  p_new_start is not distinct from j.scheduled_start then raise invalid_parameter_value; end if;
 v_duration:=case when j.scheduled_end>j.scheduled_start then j.scheduled_end-j.scheduled_start
  else greatest(j.estimated_clean_minutes,1)*interval '1 minute' end;
 insert into visit_reschedule_quotes(job_id,customer_id,requested_by,schedule_revision,recurring_plan_id,occurrence_date,
  previous_start,previous_end,new_start,new_end,price_cents,assignment_snapshot,expires_at,fee_cents)
 values(j.id,j.customer_id,auth.uid(),j.schedule_revision,j.recurring_plan_id,j.occurrence_date,j.scheduled_start,j.scheduled_end,
  p_new_start,p_new_start+v_duration,j.price_cents,visit_assignment_snapshot(j.id),clock_timestamp()+interval '5 minutes',visit_reschedule_fee(j.scheduled_start,p_new_start,clock_timestamp())) returning * into q;
 return jsonb_build_object('id',q.id,'job_id',q.job_id,'previous_start',q.previous_start,'new_start',q.new_start,
  'new_end',q.new_end,'price_cents',q.price_cents,'fee_cents',q.fee_cents,'released_count',jsonb_array_length(q.assignment_snapshot),'expires_at',q.expires_at);
end $$;

create or replace function confirm_my_visit_reschedule(p_job_id uuid,p_quote_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs%rowtype; q visit_reschedule_quotes%rowtype; r visit_reschedules%rowtype; v_plan uuid; v_fee_invoice uuid;
begin
 if not is_admin() and (current_role_of() is distinct from 'customer' or current_customer_id() is null) then raise insufficient_privilege; end if;
 -- Same lock order as cancellation and recurring materialisation.
 select recurring_plan_id into v_plan from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id());
 if v_plan is not null then perform 1 from recurring_plans where id=v_plan for update; end if;
 select * into j from jobs where id=p_job_id and (is_admin() or customer_id=current_customer_id()) for update;
 if j.id is null then raise insufficient_privilege; end if;
 select * into q from visit_reschedule_quotes where id=p_quote_id and job_id=j.id and customer_id=j.customer_id and requested_by=auth.uid();
 if q.id is null then raise insufficient_privilege; end if;
 select * into r from visit_reschedules where id=q.id;
 if r.id is not null then return to_jsonb(r); end if;
 if j.status not in ('unscheduled','scheduled','dispatching','assigned') or j.started_at is not null
  or exists(select 1 from time_entries where job_id=j.id) or q.expires_at<=clock_timestamp() or q.new_start<=clock_timestamp()
  or q.schedule_revision<>j.schedule_revision or j.recurring_plan_id is distinct from v_plan
  or q.recurring_plan_id is distinct from j.recurring_plan_id or q.occurrence_date is distinct from j.occurrence_date
  or q.assignment_snapshot<>visit_assignment_snapshot(j.id)
  or q.fee_cents<>visit_reschedule_fee(j.scheduled_start,q.new_start,clock_timestamp()) then
  raise exception 'appointment or fee changed since review' using errcode='40001';
 end if;
 -- A separate customer invoice has no service job_id, so completing the
 -- moved clean cannot mistake this fee for its service invoice. The receipt
 -- links it to this exact change. Confirmation records a balance, not a charge.
 if q.fee_cents>0 then
  insert into invoices(customer_id,kind,status,subtotal_cents,total_cents,due_on,issued_at,
   autocharge_paused_at,autocharge_paused_reason)
  values(j.customer_id,'reschedule_fee','sent',q.fee_cents,q.fee_cents,
   (clock_timestamp() at time zone 'America/Chicago')::date,clock_timestamp(),
   clock_timestamp(),'Rescheduling fee: client payment through account') returning id into v_fee_invoice;
 end if;
 insert into visit_reschedules(id,job_id,customer_id,confirmed_by,previous_start,new_start,new_end,price_cents,released_count,fee_cents,invoice_id)
 values(q.id,j.id,j.customer_id,auth.uid(),q.previous_start,q.new_start,q.new_end,q.price_cents,jsonb_array_length(q.assignment_snapshot),q.fee_cents,v_fee_invoice) returning * into r;
 insert into visit_reschedule_releases(id,reschedule_id,job_id,cleaner_id,offer_id,payout_cents,is_lead,assigned_at,previous_start,new_start)
 select a.id,r.id,j.id,a.cleaner_id,a.offer_id,a.payout_cents,a.is_lead,a.assigned_at,j.scheduled_start,q.new_start from job_assignments a where a.job_id=j.id;
 update offers set status='withdrawn',responded_at=now() where job_id=j.id and status in ('sent','accepted');
 delete from job_assignments where job_id=j.id;
 update jobs set scheduled_start=q.new_start,scheduled_end=q.new_end,status='scheduled',dispatch_channel=null where id=j.id;
 -- Keep preference requests, exclusions, photos, invoices and occurrence_date.
 -- Backup decisions retain assignment_key; the next assignment has a new ID.
 return to_jsonb(r);
end $$;
revoke all on function quote_my_visit_reschedule(uuid,timestamptz),confirm_my_visit_reschedule(uuid,uuid) from public,anon;
grant execute on function quote_my_visit_reschedule(uuid,timestamptz),confirm_my_visit_reschedule(uuid,uuid) to authenticated;

-- The updated app requires this new entry point, so an older database using
-- the superseded all-free policy cannot silently issue a free review.
create function public.quote_my_visit_reschedule_with_fee(p_job_id uuid,p_new_start timestamptz)
 returns jsonb language sql security invoker set search_path=public,pg_temp as $$
 select public.quote_my_visit_reschedule(p_job_id,p_new_start)
$$;
revoke all on function public.quote_my_visit_reschedule_with_fee(uuid,timestamptz) from public,anon;
grant execute on function public.quote_my_visit_reschedule_with_fee(uuid,timestamptz) to authenticated;


-- Stored-card consent is currently phrased for clean invoices. This new fee
-- uses explicit account checkout; even an accidentally unpaused fee cannot
-- enter the off-session payment path. Existing collection guards stay intact.
create function public.guard_reschedule_fee_collection() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_invoice public.invoices%rowtype;
begin
 select * into v_invoice from public.invoices where id=new.invoice_id for update;
 if v_invoice.kind='reschedule_fee' and new.channel='autocharge' then
  raise exception 'rescheduling fee requires account checkout' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_reschedule_fee_collection() from public,anon,authenticated;
create trigger payment_operations_reschedule_fee_guard before insert on public.payment_operations
for each row execute function public.guard_reschedule_fee_collection();
