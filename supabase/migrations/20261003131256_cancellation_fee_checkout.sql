-- Saved-card consent currently covers clean invoices. Cancellation fees use
-- explicit account checkout, just like appointment-day rescheduling fees.
create function public.keep_cancellation_fee_manual() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from visit_cancellations c where c.invoice_id=new.id) then
  new.autocharge_paused_at:=coalesce(new.autocharge_paused_at,clock_timestamp());
  new.autocharge_paused_reason:=coalesce(new.autocharge_paused_reason,'Cancellation fee: pay through account');
  new.next_attempt_at:=null;
 end if;
 return new;
end $$;
create trigger invoices_cancellation_fee_manual before update on public.invoices
 for each row execute function public.keep_cancellation_fee_manual();
revoke all on function public.keep_cancellation_fee_manual() from public,anon,authenticated,service_role;

create function public.pause_confirmed_cancellation_fee() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.invoice_id is not null then
  update invoices set autocharge_paused_at=coalesce(autocharge_paused_at,clock_timestamp()),
   autocharge_paused_reason=coalesce(autocharge_paused_reason,'Cancellation fee: pay through account'),next_attempt_at=null
   where id=new.invoice_id;
 end if;
 return new;
end $$;
create trigger cancellations_fee_manual after insert or update of invoice_id on public.visit_cancellations
 for each row execute function public.pause_confirmed_cancellation_fee();
revoke all on function public.pause_confirmed_cancellation_fee() from public,anon,authenticated,service_role;

create or replace function public.guard_canceled_visit_collection() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_invoice invoices%rowtype;begin
 select * into v_invoice from invoices where id=new.invoice_id for update;
 if v_invoice.voided_at is not null or v_invoice.status='void' or
 exists(select 1 from visit_cancellations c where c.job_id=v_invoice.job_id and c.invoice_id is distinct from v_invoice.id) then
  raise exception 'invoice unavailable for collection after cancellation' using errcode='23514';
 end if;
 if new.channel='autocharge' and exists(select 1 from visit_cancellations c where c.invoice_id=v_invoice.id) then
  raise exception 'cancellation fee requires account checkout' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_canceled_visit_collection() from public,anon,authenticated,service_role;
-- Preserve existing paid amounts, provider receipts, refunds and fee obligations.
update public.invoices i set autocharge_paused_at=coalesce(i.autocharge_paused_at,clock_timestamp()),
 autocharge_paused_reason=coalesce(i.autocharge_paused_reason,'Cancellation fee: pay through account'),next_attempt_at=null
 where exists(select 1 from public.visit_cancellations c where c.invoice_id=i.id);
