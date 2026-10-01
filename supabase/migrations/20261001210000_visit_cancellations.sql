-- Client-confirmed cancellation. Dallas appointment day is the fee boundary;
-- the previous evening is free even when less than 24 hours before the visit.
-- Provider calls belong to the existing billing routes, never these RPCs.
create table visit_cancellation_quotes (
 id uuid primary key default uuid_generate_v4(),
 job_id uuid not null references jobs(id),
 customer_id uuid not null references customers(id),
 requested_by uuid not null references profiles(id),
 recurring_plan_id uuid references recurring_plans(id),
 occurrence_date date,
 reason text not null check (reason in ('cancel','skip','door_turnaway')),
 scheduled_start timestamptz,
 fee_cents integer not null check (fee_cents in (0,6000)),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create table visit_cancellations (
 id uuid primary key references visit_cancellation_quotes(id),
 job_id uuid not null unique references jobs(id),
 customer_id uuid not null references customers(id),
 confirmed_by uuid not null references profiles(id),
 reason text not null check (reason in ('cancel','skip','door_turnaway')),
 scheduled_start timestamptz,
 fee_cents integer not null check (fee_cents in (0,6000)),
 invoice_id uuid unique references invoices(id),
 billing_review boolean not null,
 billing_resolved_by uuid references profiles(id),
 billing_resolved_at timestamptz,
 canceled_at timestamptz not null default now()
);
alter table visit_cancellation_quotes enable row level security;
alter table visit_cancellations enable row level security;
create policy cancellation_quotes_read on visit_cancellation_quotes for select to authenticated
 using (requested_by=auth.uid() and (is_admin() or customer_id=current_customer_id()));
create policy cancellations_read on visit_cancellations for select to authenticated
 using (is_admin() or customer_id=current_customer_id());
revoke all on visit_cancellation_quotes,visit_cancellations from anon,authenticated;
grant select on visit_cancellation_quotes,visit_cancellations to authenticated;
grant all on visit_cancellation_quotes,visit_cancellations to service_role;

create function visit_cancellation_fee(p_start timestamptz,p_reason text,p_now timestamptz)
 returns integer language sql immutable set search_path=public,pg_temp as $$
 select case when p_reason='door_turnaway' or
 (p_start at time zone 'America/Chicago')::date=(p_now at time zone 'America/Chicago')::date
 then 6000 else 0 end
$$;
revoke all on function visit_cancellation_fee(timestamptz,text,timestamptz) from public,anon,authenticated;

create function quote_my_visit_cancellation(p_job_id uuid,p_reason text)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype; v_quote visit_cancellation_quotes%rowtype; v_admin boolean;
begin
 v_admin:=is_admin();
 if auth.uid() is null or not (v_admin or exists(select 1 from profiles where id=auth.uid() and role='customer')) then
  raise exception 'client or office account required' using errcode='42501';
 end if;
 if p_reason not in ('cancel','skip','door_turnaway') or p_reason is null or (p_reason='door_turnaway' and not v_admin) then
  raise exception 'invalid cancellation reason' using errcode='22023';
 end if;
 select * into v_job from jobs where id=p_job_id for update;
 if v_job.id is null or (not v_admin and v_job.customer_id is distinct from current_customer_id()) then
  raise exception 'visit unavailable' using errcode='42501';
 end if;
 if v_job.status not in ('unscheduled','scheduled','dispatching','assigned') or v_job.started_at is not null then
  raise exception 'visit is already started or closed' using errcode='40001';
 end if;
 if p_reason='skip' and (v_job.recurring_plan_id is null or v_job.occurrence_date is null) then
  raise exception 'only a recurring visit can be skipped' using errcode='22023';
 end if;
 if not v_admin and v_job.scheduled_start is not null and
 (v_job.scheduled_start at time zone 'America/Chicago')::date < (clock_timestamp() at time zone 'America/Chicago')::date then
  raise exception 'past visit needs office review' using errcode='40001';
 end if;
 insert into visit_cancellation_quotes(job_id,customer_id,requested_by,reason,scheduled_start,fee_cents,expires_at,recurring_plan_id,occurrence_date)
 values(v_job.id,v_job.customer_id,auth.uid(),p_reason,v_job.scheduled_start,
 visit_cancellation_fee(v_job.scheduled_start,p_reason,clock_timestamp()),clock_timestamp()+interval '5 minutes',v_job.recurring_plan_id,v_job.occurrence_date)
 returning * into v_quote;
 return to_jsonb(v_quote);
end $$;

create function confirm_my_visit_cancellation(p_job_id uuid,p_quote_id uuid)
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
  raise exception 'visit or fee changed; review again' using errcode='40001';
 end if;
 if v_quote.reason='door_turnaway' and not v_admin then raise exception 'office required' using errcode='42501'; end if;
 if v_job.recurring_plan_id is not null and v_job.occurrence_date is not null then
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
  insert into invoices(job_id,customer_id,status,subtotal_cents,total_cents,due_on,issued_at)
  values(p_job_id,v_job.customer_id,'sent',v_quote.fee_cents,v_quote.fee_cents,
   (clock_timestamp() at time zone 'America/Chicago')::date,clock_timestamp()) returning id into v_fee_invoice;
 end if;
 insert into visit_cancellations(id,job_id,customer_id,confirmed_by,reason,scheduled_start,fee_cents,invoice_id,billing_review)
 values(v_quote.id,p_job_id,v_job.customer_id,auth.uid(),v_quote.reason,v_job.scheduled_start,v_quote.fee_cents,v_fee_invoice,v_review)
 returning * into v_saved;
 return to_jsonb(v_saved);
end $$;
revoke all on function quote_my_visit_cancellation(uuid,text),confirm_my_visit_cancellation(uuid,uuid) from public,anon;
grant execute on function quote_my_visit_cancellation(uuid,text),confirm_my_visit_cancellation(uuid,uuid) to authenticated;

-- Eligibility gates new/live work, not withdrawal of historical offers.
alter table offers drop constraint offers_cleaner_must_be_eligible;
alter table offers add constraint offers_cleaner_must_be_eligible
 check (status not in ('sent','accepted') or cleaner_is_eligible(cleaner_id,job_id)) not valid;
create function guard_open_visit_offer() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job jobs%rowtype;
begin
 if new.status in ('sent','accepted') and (tg_op='INSERT' or new.status is distinct from old.status) then
  select * into v_job from jobs where id=new.job_id for update;
  if v_job.status not in ('unscheduled','scheduled','dispatching') or v_job.started_at is not null
  or exists(select 1 from job_assignments where job_id=new.job_id) then
   raise exception 'visit no longer open for offers' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
create trigger offers_open_visit before insert or update on offers for each row execute function guard_open_visit_offer();
revoke all on function guard_open_visit_offer() from public,anon,authenticated;

create function guard_canceled_visit_collection() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_invoice invoices%rowtype;
begin
 select * into v_invoice from invoices where id=new.invoice_id for update;
 if v_invoice.voided_at is not null or v_invoice.status='void' or
 exists(select 1 from visit_cancellations c where c.job_id=v_invoice.job_id and c.invoice_id is distinct from v_invoice.id) then
  raise exception 'invoice unavailable for collection after cancellation' using errcode='23514';
 end if;
 return new;
end $$;
create trigger payment_operations_cancellation_guard before insert on payment_operations for each row execute function guard_canceled_visit_collection();
revoke all on function guard_canceled_visit_collection() from public,anon,authenticated;

create or replace function respond_to_offer(
  p_offer_id   uuid,
  p_cleaner_id uuid,
  p_accept     boolean,
  p_reason     text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_offer   offers%rowtype;
  v_job     jobs%rowtype;
  v_taken   boolean;
begin
  select * into v_offer from offers
  where id = p_offer_id and cleaner_id = p_cleaner_id;
  if v_offer.id is null then return 'not_found'; end if;

  if v_offer.status <> 'sent' then
    return case when v_offer.status='expired' then 'expired' else 'superseded' end;
  end if;

  -- Lock the JOB, not the offer. The race worth arbitrating is two cleaners
  -- accepting two different offers on one job; locking each of their own rows
  -- would let both through.
  select * into v_job from jobs where id = v_offer.job_id for update;
  if v_job.id is null then return 'not_found'; end if;

  -- Re-read after the job lock: a winner or cancellation may have withdrawn
  -- this offer while this caller waited. Preserve 'taken' for a competing
  -- acceptance. An offer already withdrawn at the initial read remains stale.
  select * into v_offer from offers where id=p_offer_id and cleaner_id=p_cleaner_id;
  if p_accept and v_offer.status in ('sent','withdrawn') and v_job.status='assigned'
     and exists(select 1 from job_assignments where job_id=v_job.id) then
    if v_offer.status='sent' then
      update offers set status='withdrawn',responded_at=now() where id=p_offer_id;
    end if;
    return 'taken';
  end if;
  if v_offer.status <> 'sent' then
    return case when v_offer.status='expired' then 'expired' else 'superseded' end;
  end if;
  if v_job.status not in ('unscheduled','scheduled','dispatching') or v_job.started_at is not null then
    return 'superseded';
  end if;

  if not p_accept then
    update offers set status = 'declined', responded_at = now(), decline_reason = p_reason
    where id = p_offer_id;
    return 'declined';
  end if;

  -- Expiry is checked under the lock and against the database's clock, so a
  -- device with a slow clock cannot accept a countdown that has already run
  -- out somewhere else.
  if v_offer.expires_at <= now() then
    update offers set status = 'expired', responded_at = now() where id = p_offer_id;
    return 'expired';
  end if;

  select exists (select 1 from job_assignments where job_id = v_offer.job_id)
  into v_taken;
  if v_taken then
    -- Not her fault and not an error. Withdraw the offer so it stops counting
    -- against her acceptance rate — declining work that no longer exists is
    -- not declining work, and a ranking that says otherwise punishes the
    -- cleaners who answer fastest.
    update offers set status = 'withdrawn', responded_at = now() where id = p_offer_id;
    return 'taken';
  end if;

  update offers set status = 'accepted', responded_at = now() where id = p_offer_id;

  insert into job_assignments (job_id, cleaner_id, offer_id, is_lead, payout_cents)
  values (v_offer.job_id, p_cleaner_id, p_offer_id, true, v_offer.payout_cents);

  update jobs set status = 'assigned', dispatch_channel = v_offer.channel
  where id = v_offer.job_id;

  -- Everyone else's screen goes quiet. Withdrawn rather than expired: the
  -- offer did not run out of time, it stopped existing.
  update offers set status = 'withdrawn', responded_at = now()
  where job_id = v_offer.job_id and id <> p_offer_id and status = 'sent';

  return 'accepted';
end $$;


-- An old dispatch decision cannot reopen a client-canceled visit.
create function guard_confirmed_cancellation() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.status='canceled' and new.status<>'canceled' and exists(select 1 from visit_cancellations where job_id=old.id) then
  raise exception 'a confirmed cancellation cannot be reopened by dispatch' using errcode='23514';
 end if;
 return new;
end $$;
create trigger jobs_confirmed_cancellation before update on jobs for each row execute function guard_confirmed_cancellation();
revoke all on function guard_confirmed_cancellation() from public,anon,authenticated;

-- Office resolution follows provider reconciliation/refund confirmation. It
-- never sends a refund or starts a payment. Do not raise a second obligation
-- while any captured money or pending provider outcome remains on the clean.
create function resolve_visit_cancellation_billing(p_job_id uuid,p_cancellation_id uuid)
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
   raise exception 'existing payments or refunds still need reconciliation' using errcode='40001';
  end if;
  if v_invoice.voided_at is null then update invoices set status='void',voided_at=clock_timestamp(),next_attempt_at=null where id=v_invoice.id; end if;
 end loop;
 if v_saved.fee_cents>0 then
  insert into invoices(job_id,customer_id,status,subtotal_cents,total_cents,due_on,issued_at)
  values(p_job_id,v_saved.customer_id,'sent',v_saved.fee_cents,v_saved.fee_cents,
   (clock_timestamp() at time zone 'America/Chicago')::date,clock_timestamp()) returning id into v_fee_invoice;
 end if;
 update visit_cancellations set billing_review=false,invoice_id=v_fee_invoice,billing_resolved_by=auth.uid(),billing_resolved_at=clock_timestamp()
 where id=v_saved.id returning * into v_saved;
 return to_jsonb(v_saved);
end $$;
revoke all on function resolve_visit_cancellation_billing(uuid,uuid) from public,anon;
grant execute on function resolve_visit_cancellation_billing(uuid,uuid) to authenticated;
