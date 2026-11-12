-- Management issues an exact reviewed service bill. No provider is invoked.
create table spotless_private.service_invoice_issuances (
 invoice_id uuid primary key references public.invoices(id),
 job_id uuid not null references public.jobs(id),
 customer_id uuid not null references public.customers(id),
 property_id uuid not null references public.properties(id),
 issued_by uuid not null references public.profiles(id),
 total_cents integer not null check(total_cents>=0),
 due_on date not null,
 issued_at timestamptz not null
);
alter table spotless_private.service_invoice_issuances enable row level security;
revoke all on spotless_private.service_invoice_issuances from public,anon,authenticated,service_role;

create function public.issue_reviewed_service_invoice(
 p_job uuid,p_invoice uuid,p_actor uuid,p_reviewed_total integer,p_due date
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.jobs%rowtype;i public.invoices%rowtype;s public.job_room_scopes%rowtype;
 r spotless_private.service_invoice_issuances%rowtype;keys text[];v_issued_at timestamptz;
begin
 if p_job is null or p_invoice is null or p_actor is null or p_reviewed_total is null or p_reviewed_total<0 or p_due is null or not isfinite(p_due) then raise invalid_parameter_value;end if;
 perform 1 from public.profiles where id=p_actor and role='admin' for share;
 if not found then raise insufficient_privilege;end if;
 -- Same ordering as draft preparation, photo recording and settlement.
 select * into j from public.jobs where id=p_job for update;
 select * into i from public.invoices where id=p_invoice for update;
 if j.id is null or i.id is null or i.job_id is distinct from j.id or i.customer_id is distinct from j.customer_id or i.kind<>'service' or i.voided_at is not null or i.status='void' then
  raise exception 'Review the saved service invoice' using errcode='PIS01';
 end if;
 select * into r from spotless_private.service_invoice_issuances where invoice_id=i.id;
 if r.invoice_id is not null then
  if i.status not in ('sent','paid','overdue') or r.job_id is distinct from j.id or r.customer_id is distinct from j.customer_id or r.property_id is distinct from j.property_id or r.total_cents is distinct from p_reviewed_total or r.due_on is distinct from p_due or i.issued_at is distinct from r.issued_at or i.due_on is distinct from r.due_on then
   raise exception 'The invoice review changed' using errcode='PIS01';
  end if;
 else
  if p_due<(clock_timestamp() at time zone 'America/Chicago')::date or j.status<>'complete' or i.status<>'draft' or i.issued_at is not null or i.total_cents is distinct from p_reviewed_total or i.subtotal_cents is distinct from j.price_cents or i.total_cents is distinct from i.subtotal_cents or i.tip_cents<>0 or i.amount_paid_cents<>0 or i.refunded_cents<>0 or i.credit_cents<>0 or i.stripe_checkout_session_id is not null
   or (select count(*) from public.invoices where job_id=j.id and kind='service')<>1
   or exists(select 1 from public.payments where invoice_id=i.id)
   or exists(select 1 from public.payment_operations where invoice_id=i.id and state in ('open','abandoned')) then
   raise exception 'The invoice review changed' using errcode='PIS01';
  end if;
  perform 1 from public.properties where id=j.property_id and customer_id=j.customer_id for share;
  if not found then raise exception 'Review visit ownership' using errcode='PIS01';end if;
  select * into s from public.job_room_scopes where job_id=j.id and customer_id=j.customer_id and property_id=j.property_id for share;
  if s.job_id is null then raise exception 'Review the saved room list' using errcode='PIS01';end if;
  keys:=spotless_private.required_photo_keys(s.bedrooms,s.bathrooms,s.half_baths,s.kitchens,s.living_rooms,s.utility_rooms);
  perform 1 from storage.objects o join public.job_photos ph on o.bucket_id='job-photos' and o.name=ph.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
   where ph.job_id=j.id and ph.room_key=any(keys) and ph.kind in ('before','after') order by o.id for share of o;
  if exists(select 1 from unnest(keys) room cross join (values('before'),('after')) kind(k)
   where not exists(select 1 from public.job_photos ph join storage.objects o on o.bucket_id='job-photos' and o.name=ph.storage_path and o.archived_at is null and not coalesce(o.is_delete_marker,false)
    where ph.job_id=j.id and ph.room_key=room and ph.kind=kind.k and ph.storage_path='jobs/'||j.id::text||'/'||room||'-'||kind.k||'.jpg')) then
   raise exception 'Review the saved photo evidence' using errcode='PIS01';
  end if;
  v_issued_at:=clock_timestamp();
  update public.invoices set status='sent',issued_at=v_issued_at,due_on=p_due,next_attempt_at=null where id=i.id;
  update public.jobs set invoiced_at=coalesce(invoiced_at,v_issued_at) where id=j.id;
  insert into spotless_private.service_invoice_issuances(invoice_id,job_id,customer_id,property_id,issued_by,total_cents,due_on,issued_at)
   values(i.id,j.id,j.customer_id,j.property_id,p_actor,i.total_cents,p_due,v_issued_at) returning * into r;
 end if;
 return jsonb_build_object('issued',true,'visitId',r.job_id,'invoiceId',r.invoice_id,'totalCents',r.total_cents,'dueOn',r.due_on,'issuedAt',r.issued_at);
end $$;
revoke all on function public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date) from public,anon,authenticated;
grant execute on function public.issue_reviewed_service_invoice(uuid,uuid,uuid,integer,date) to service_role;
