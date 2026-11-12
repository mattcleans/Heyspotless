-- New change fees are drafts until Management explicitly reviews and issues them.
-- Preserve all previously issued or paid records; no provider is invoked.
alter table public.invoices drop constraint invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check
 check(kind in ('service','reschedule_fee','cancellation_fee'));
alter table public.invoices add constraint invoices_cancellation_fee_shape
 check(kind<>'cancellation_fee' or (job_id is null and subtotal_cents=6000 and total_cents=6000 and tip_cents=0));

create or replace function public.confirm_my_visit_cancellation(p_job_id uuid,p_quote_id uuid)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_quote visit_cancellation_quotes%rowtype;
 v_saved visit_cancellations%rowtype; v_invoice invoices%rowtype; v_review boolean:=false;
 v_fee_invoice uuid; v_admin boolean; v_plan uuid;
begin
 v_admin:=is_admin();
 if auth.uid() is null or not (v_admin or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 -- Generator and skips lock the plan before the job. Use the same order.
 select recurring_plan_id into v_plan from jobs where id=p_job_id and (v_admin or customer_id=current_customer_id());
 if not found then raise exception 'visit unavailable' using errcode='42501'; end if;
 if v_plan is not null then perform 1 from recurring_plans where id=v_plan for update; end if;
 select * into v_job from jobs where id=p_job_id for update;
 if v_job.id is null or (not v_admin and v_job.customer_id is distinct from current_customer_id()) then
  raise exception 'visit unavailable' using errcode='42501';
 end if;
 select * into v_quote from visit_cancellation_quotes where id=p_quote_id;
 if v_quote.id is null or v_quote.job_id<>p_job_id or v_quote.requested_by<>auth.uid()
 or v_quote.customer_id<>v_job.customer_id then
  raise exception 'review this visit cancellation' using errcode='42501';
 end if;
 select * into v_saved from visit_cancellations where id=p_quote_id;
 if v_saved.id is not null then return to_jsonb(v_saved); end if;
 if v_job.status not in ('unscheduled','scheduled','dispatching','assigned') or v_job.started_at is not null
 or v_quote.scheduled_start is distinct from v_job.scheduled_start or v_quote.expires_at<=clock_timestamp()
 or v_job.recurring_plan_id is distinct from v_plan or v_quote.recurring_plan_id is distinct from v_job.recurring_plan_id
 or v_quote.occurrence_date is distinct from v_job.occurrence_date
 or v_quote.fee_cents<>visit_cancellation_fee(v_job.scheduled_start,v_quote.reason,clock_timestamp()) then
  raise exception 'visit or fee changed; review again' using errcode='PT409';
 end if;
 if v_quote.reason='door_turnaway' and not v_admin then raise exception 'office required' using errcode='42501'; end if;
 if v_job.recurring_plan_id is not null and v_job.occurrence_date is not null and v_job.generation_epoch=(select generation_epoch from recurring_plans where id=v_job.recurring_plan_id and customer_id=v_job.customer_id) then
  insert into recurring_plan_skips(plan_id,occurrence_date,reason,created_by)
  values(v_job.recurring_plan_id,v_job.occurrence_date,'Client-confirmed '||v_quote.reason,auth.uid())
  on conflict(plan_id,occurrence_date) do nothing;
 end if;
 -- An inactive cleaner must not prevent withdrawing old offers.
 update offers set status='withdrawn',responded_at=clock_timestamp() where job_id=p_job_id and status='sent';
 update jobs set status='canceled',dispatch_channel=null where id=p_job_id;
 update visit_cleaner_requests set status='withdrawn' where job_id=p_job_id and status='pending';
 -- Serialise with collection. Existing/uncertain provider payments need office
 -- reconciliation; cancel the appointment now without inventing a refund.
 for v_invoice in select * from invoices where job_id=p_job_id order by id for update loop
  if v_invoice.amount_paid_cents>0 or v_invoice.refunded_cents>0 or v_invoice.stripe_checkout_session_id is not null
  or exists(select 1 from payment_operations where invoice_id=v_invoice.id and (state='open' or stripe_object_id is not null)) then
   v_review:=true;
   update invoices set autocharge_paused_at=coalesce(autocharge_paused_at,clock_timestamp()),
    autocharge_paused_reason='Canceled visit: reconcile existing payment before collecting',next_attempt_at=null where id=v_invoice.id;
  elsif v_invoice.voided_at is null then
   update invoices set status='void',voided_at=clock_timestamp(),next_attempt_at=null where id=v_invoice.id;
  end if;
 end loop;
 if v_quote.fee_cents>0 and not v_review then
  insert into invoices(customer_id,kind,status,subtotal_cents,total_cents,due_on,issued_at,autocharge_paused_at,autocharge_paused_reason)
  values(v_job.customer_id,'cancellation_fee','draft',v_quote.fee_cents,v_quote.fee_cents,null,null,
   clock_timestamp(),'Cancellation fee: Management review required') returning id into v_fee_invoice;
 end if;
 insert into visit_cancellations(id,job_id,customer_id,confirmed_by,reason,scheduled_start,fee_cents,invoice_id,billing_review)
 values(v_quote.id,p_job_id,v_job.customer_id,auth.uid(),v_quote.reason,v_job.scheduled_start,v_quote.fee_cents,v_fee_invoice,v_review)
 returning * into v_saved;
 return to_jsonb(v_saved);
end $$;

create or replace function public.resolve_visit_cancellation_billing(p_job_id uuid,p_cancellation_id uuid)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_saved visit_cancellations%rowtype; v_invoice invoices%rowtype; v_fee_invoice uuid;
begin
 if auth.uid() is null or not is_admin() then raise exception 'office required' using errcode='42501'; end if;
 perform 1 from jobs where id=p_job_id for update;
 select * into v_saved from visit_cancellations where id=p_cancellation_id and job_id=p_job_id for update;
 if v_saved.id is null then raise exception 'cancellation unavailable' using errcode='42501'; end if;
 if not v_saved.billing_review then return to_jsonb(v_saved); end if;
 for v_invoice in select * from invoices where job_id=p_job_id order by id for update loop
  if v_invoice.amount_paid_cents<>v_invoice.refunded_cents or
  exists(select 1 from payment_operations where invoice_id=v_invoice.id and state='open') or
  exists(select 1 from refunds r join payments p on p.id=r.payment_id where p.invoice_id=v_invoice.id and r.status='pending') then
   raise exception 'existing payments or refunds still need reconciliation' using errcode='PT409';
  end if;
  if v_invoice.voided_at is null then update invoices set status='void',voided_at=clock_timestamp(),next_attempt_at=null where id=v_invoice.id; end if;
 end loop;
 if v_saved.fee_cents>0 then
  insert into invoices(customer_id,kind,status,subtotal_cents,total_cents,due_on,issued_at,autocharge_paused_at,autocharge_paused_reason)
  values(v_saved.customer_id,'cancellation_fee','draft',v_saved.fee_cents,v_saved.fee_cents,null,null,
   clock_timestamp(),'Cancellation fee: Management review required') returning id into v_fee_invoice;
 end if;
 update visit_cancellations set billing_review=false,invoice_id=v_fee_invoice,billing_resolved_by=auth.uid(),billing_resolved_at=clock_timestamp()
 where id=v_saved.id returning * into v_saved;
 return to_jsonb(v_saved);
end $$;

create or replace function public.confirm_my_visit_reschedule(p_job_id uuid,p_quote_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
  raise exception 'appointment or fee changed since review' using errcode='PT409';
 end if;
 -- A separate customer invoice has no service job_id, so completing the
 -- moved clean cannot mistake this fee for its service invoice. The receipt
 -- links it to this exact change. Confirmation records a balance, not a charge.
 if q.fee_cents>0 then
  insert into invoices(customer_id,kind,status,subtotal_cents,total_cents,due_on,issued_at,
   autocharge_paused_at,autocharge_paused_reason)
  values(j.customer_id,'reschedule_fee','draft',q.fee_cents,q.fee_cents,null,null,
   clock_timestamp(),'Rescheduling fee: Management review required') returning id into v_fee_invoice;
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

create or replace function public.guard_reschedule_fee_collection() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i public.invoices%rowtype;
begin
 select * into i from public.invoices where id=new.invoice_id for update;
 if i.kind in ('reschedule_fee','cancellation_fee') and (i.status not in ('sent','overdue') or i.issued_at is null) then
  raise exception 'change fee requires Management issuance' using errcode='23514';
 end if;
 if i.kind in ('reschedule_fee','cancellation_fee') and new.channel='autocharge' then
  raise exception 'change fee requires account checkout' using errcode='23514';
 end if;
 return new;
end $$;

create table spotless_private.change_fee_issuances (
 invoice_id uuid primary key references public.invoices(id),
 job_id uuid not null references public.jobs(id),
 customer_id uuid not null references public.customers(id),
 change_id uuid not null,
 kind text not null check(kind in ('cancellation_fee','reschedule_fee')),
 issued_by uuid not null references public.profiles(id),
 total_cents integer not null check(total_cents=6000),
 due_on date not null,
 issued_at timestamptz not null,
 unique(kind,change_id)
);
alter table spotless_private.change_fee_issuances enable row level security;
revoke all on spotless_private.change_fee_issuances from public,anon,authenticated,service_role;

create function public.issue_reviewed_change_fee(
 p_invoice uuid,p_change uuid,p_kind text,p_actor uuid,p_reviewed_total integer,p_due date
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i public.invoices%rowtype;j public.jobs%rowtype;r spotless_private.change_fee_issuances%rowtype;
 v_job uuid;v_customer uuid;v_fee integer;v_review boolean;v_issued timestamptz;
begin
 if p_invoice is null or p_change is null or p_actor is null or p_kind is null
  or p_kind not in ('cancellation_fee','reschedule_fee') or p_reviewed_total is distinct from 6000
  or p_due is null or not isfinite(p_due) then raise invalid_parameter_value;end if;
 perform 1 from public.profiles where id=p_actor and role='admin' for share;
 if not found then raise insufficient_privilege;end if;
 if p_kind='cancellation_fee' then
  select job_id into v_job from public.visit_cancellations where id=p_change and invoice_id=p_invoice;
 else
  select job_id into v_job from public.visit_reschedules where id=p_change and invoice_id=p_invoice;
 end if;
 if v_job is null then raise exception 'Review the saved change fee' using errcode='PIF01';end if;
 -- Match visit-change and collection lock ordering: visit, then invoice.
 select * into j from public.jobs where id=v_job for update;
 select * into i from public.invoices where id=p_invoice for update;
 if p_kind='cancellation_fee' then
  select customer_id,fee_cents,billing_review into v_customer,v_fee,v_review
   from public.visit_cancellations where id=p_change and invoice_id=p_invoice and job_id=j.id for share;
 else
  select customer_id,fee_cents,false into v_customer,v_fee,v_review
   from public.visit_reschedules where id=p_change and invoice_id=p_invoice and job_id=j.id for share;
 end if;
 if j.id is null or i.id is null or v_customer is null or v_review is distinct from false
  or v_fee is distinct from p_reviewed_total or i.kind is distinct from p_kind
  or i.customer_id is distinct from v_customer or j.customer_id is distinct from v_customer
  or i.job_id is not null or i.voided_at is not null or i.status='void' then
  raise exception 'Review the saved change fee' using errcode='PIF01';end if;
 select * into r from spotless_private.change_fee_issuances where invoice_id=i.id;
 if r.invoice_id is not null then
  if r.job_id is distinct from j.id or r.customer_id is distinct from v_customer
   or r.change_id is distinct from p_change or r.kind is distinct from p_kind
   or r.total_cents is distinct from p_reviewed_total or r.due_on is distinct from p_due
   or i.total_cents is distinct from r.total_cents or i.due_on is distinct from r.due_on
   or i.issued_at is distinct from r.issued_at or i.status not in ('sent','paid','overdue') then
   raise exception 'The fee review changed' using errcode='PIF01';end if;
 else
  if p_due<(clock_timestamp() at time zone 'America/Chicago')::date or i.status<>'draft'
   or i.issued_at is not null or i.total_cents is distinct from p_reviewed_total
   or i.subtotal_cents is distinct from p_reviewed_total or i.tip_cents<>0
   or i.amount_paid_cents<>0 or i.refunded_cents<>0 or i.credit_cents<>0
   or i.stripe_checkout_session_id is not null
   or exists(select 1 from public.payments where invoice_id=i.id)
   or exists(select 1 from public.payment_operations where invoice_id=i.id and state in ('open','abandoned')) then
   raise exception 'The fee review changed' using errcode='PIF01';end if;
  v_issued:=clock_timestamp();
  update public.invoices set status='sent',issued_at=v_issued,due_on=p_due,next_attempt_at=null where id=i.id;
  insert into spotless_private.change_fee_issuances(invoice_id,job_id,customer_id,change_id,kind,issued_by,total_cents,due_on,issued_at)
   values(i.id,j.id,v_customer,p_change,p_kind,p_actor,p_reviewed_total,p_due,v_issued) returning * into r;
 end if;
 return jsonb_build_object('issued',true,'visitId',r.job_id,'invoiceId',r.invoice_id,'changeId',r.change_id,
  'kind',r.kind,'totalCents',r.total_cents,'dueOn',r.due_on,'issuedAt',r.issued_at);
end $$;
revoke all on function public.issue_reviewed_change_fee(uuid,uuid,text,uuid,integer,date) from public,anon,authenticated;
grant execute on function public.issue_reviewed_change_fee(uuid,uuid,text,uuid,integer,date) to service_role;

create function public.guard_change_fee_invoice() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if tg_op='UPDATE' and old.kind in ('cancellation_fee','reschedule_fee') and new.kind is distinct from old.kind then
  raise exception 'change fee kind is immutable' using errcode='23514';end if;
 if new.kind in ('cancellation_fee','reschedule_fee') then
  new.autocharge_paused_at:=coalesce(new.autocharge_paused_at,clock_timestamp());
  new.autocharge_paused_reason:='Change fee: Client checkout after Management issuance';
  new.next_attempt_at:=null;
 end if;
 return new;
end $$;
revoke all on function public.guard_change_fee_invoice() from public,anon,authenticated;
create trigger invoices_change_fee_guard before insert or update on public.invoices
for each row execute function public.guard_change_fee_invoice();
