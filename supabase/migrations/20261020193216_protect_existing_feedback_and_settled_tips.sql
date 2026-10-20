-- A paid or transferred payout is an historical receipt. Its tip cannot be
-- replaced by an upsert, including when settlement races a Client tip request.
create or replace function public.record_tip_payout(
 p_job_id uuid,p_tip_cents integer,p_fee_rate numeric default 0.029
) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_cleaner_id uuid; v_fee integer; v_id uuid;
begin
 if p_tip_cents is null or p_tip_cents<0 then
  raise exception 'a tip cannot be negative' using errcode='check_violation';
 end if;
 select ja.cleaner_id into v_cleaner_id from public.job_assignments ja
  where ja.job_id=p_job_id order by ja.is_lead desc,ja.assigned_at limit 1;
 if v_cleaner_id is null then return null; end if;
 v_fee:=floor(p_tip_cents*p_fee_rate);
 insert into public.payouts(cleaner_id,job_id,amount_cents,tip_cents,tip_fee_cents,tip_net_cents)
 values(v_cleaner_id,p_job_id,0,p_tip_cents,v_fee,p_tip_cents-v_fee)
 on conflict(job_id,cleaner_id) where job_id is not null do update set
  tip_cents=excluded.tip_cents,tip_fee_cents=excluded.tip_fee_cents,tip_net_cents=excluded.tip_net_cents
 where payouts.paid_at is null and payouts.stripe_transfer_id is null
 returning id into v_id;
 if v_id is null then raise exception using errcode='55000',message='tip_settled_review'; end if;
 return v_id;
end $$;
revoke all on function public.record_tip_payout(uuid,integer,numeric) from public,anon,authenticated;
grant execute on function public.record_tip_payout(uuid,integer,numeric) to service_role;

-- Keep a Client rating durable while invoice and payout tips commit together.
create or replace function public.record_client_visit_feedback(
 p_profile_id uuid,p_job_id uuid,p_score numeric,p_comment text,
 p_highlights text[],p_private_note text,p_tip_cents integer default 0
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 v_job public.jobs%rowtype; v_invoice public.invoices%rowtype;
 v_candidate record; v_count integer:=0; v_leads integer;
 v_rating uuid; v_payout uuid; v_tip jsonb; v_error text; v_comment text;
begin
 if p_score is null or p_score<1 or p_score>5 or trunc(p_score)<>p_score
  or p_tip_cents is null or p_tip_cents<0 then
  raise invalid_parameter_value;
 end if;
 select j.* into v_job from public.jobs j
  join public.customers c on c.id=j.customer_id
  join public.profiles p on p.id=c.profile_id
  where j.id=p_job_id and p.id=p_profile_id and p.role='customer'
   and j.status='complete' for update of j;
 if v_job.id is null then return jsonb_build_object('recorded',false); end if;
 -- The current rating form has no public-review editor. An omitted comment
 -- must not erase text that the Client previously submitted through another UI.
 select r.comment into v_comment from public.ratings r
  where r.job_id=p_job_id and r.customer_id=v_job.customer_id for update;
 v_rating:=public.record_rating_detailed(p_job_id,p_score,coalesce(p_comment,v_comment),p_highlights,p_private_note);
 if v_rating is null then return jsonb_build_object('recorded',false); end if;
 if p_tip_cents=0 then return jsonb_build_object('recorded',true,'tip',null); end if;

 -- This exception block is a subtransaction: a tip failure rolls back BOTH
 -- money records without losing the rating saved above.
 begin
  select count(*) into v_leads from public.job_assignments where job_id=p_job_id and is_lead;
  if v_leads<>1 then raise exception 'tip_assignment_review'; end if;
  for v_candidate in
   select i.* from public.invoices i where i.job_id=p_job_id and i.customer_id=v_job.customer_id
    and i.voided_at is null and i.status not in ('draft','void')
    and not exists(select 1 from public.visit_cancellations c where c.invoice_id=i.id)
    and not exists(select 1 from public.visit_reschedules r where r.invoice_id=i.id)
   order by i.id for update
  loop v_count:=v_count+1; v_invoice:=v_candidate; end loop;
  if v_count=0 then raise exception 'tip_no_invoice'; end if;
  if v_count<>1 then raise exception 'tip_invoice_review'; end if;
  if exists(select 1 from public.payment_operations o where o.invoice_id=v_invoice.id and o.state='open') then
   raise exception 'tip_payment_in_progress';
  end if;
  if p_tip_cents>v_invoice.subtotal_cents then raise exception 'tip_above_price'; end if;
  perform public.set_invoice_tip(v_invoice.id,p_tip_cents);
  v_payout:=public.record_tip_payout(p_job_id,p_tip_cents);
  if v_payout is null then raise exception 'tip_assignment_review'; end if;
  perform public.resettle_invoice(v_invoice.id);
  select jsonb_build_object('tipCents',p.tip_cents,'feeCents',p.tip_fee_cents,'netCents',p.tip_net_cents)
   into v_tip from public.payouts p where p.id=v_payout;
  return jsonb_build_object('recorded',true,'tip',v_tip);
 exception when others then
  v_error:=sqlerrm;
  if v_error not in ('tip_assignment_review','tip_no_invoice','tip_invoice_review',
   'tip_payment_in_progress','tip_above_price','tip_settled_review') then v_error:='tip_unavailable'; end if;
  return jsonb_build_object('recorded',true,'tip',null,'tipError',v_error);
 end;
end $$;
revoke all on function public.record_client_visit_feedback(uuid,uuid,numeric,text,text[],text,integer)
 from public,anon,authenticated;
grant execute on function public.record_client_visit_feedback(uuid,uuid,numeric,text,text[],text,integer)
 to service_role;
