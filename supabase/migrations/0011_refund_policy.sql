-- ============================================================================
-- 0011 — refunds: what a refund does to what is owed
--
-- 0006 had one rule for every refund: `refunded_cents` goes up, and because
-- balance is `total - paid + refunded`, the invoice becomes collectible
-- again. It was written down as a virtue — "a refund RESTORES balance rather
-- than shrinking the invoice" — and for reporting it is the right instinct.
-- Gross captured and gross refunded must both survive, or a refunded job
-- disappears from the books and job costing lies.
--
-- But it conflated two questions that have different answers:
--
--     1. What did we take, and what did we give back?   (reporting)
--     2. What does the customer still owe?              (collection)
--
-- Under one rule, handing a customer $50 back as an apology turned $50 into
-- money owed again — and with autopay on, the sweep would take it straight
-- off their card. The apology becomes a second charge. That is the bug.
--
-- The fix is a third number. An ADJUSTMENT (a credit) records that we have
-- decided not to collect something; a REFUND records that cash went back.
-- A goodwill gesture is both, and they cancel:
--
--     balance = total - credits - paid + refunds
--
--   $170 invoice, paid in full, $50 goodwill refund:
--     total 17000, credits 5000, paid 17000, refunds 5000  ->  balance 0
--     net retained = 17000 - 5000 = 12000
--   $120 kept, nothing outstanding, nothing to charge. Gross revenue is
--   still 17000 and gross refunded is still 5000, so reporting is untouched.
--
-- WHAT EACH KIND MEANS, and this is the policy, stated once:
--
--   goodwill    Money back as a gesture; the work stands. A matching credit
--               is raised automatically, so nothing becomes collectible.
--               THIS IS THE DEFAULT, including for refunds issued from the
--               Stripe dashboard, because a refund of unknown intent must
--               never turn itself into a fresh charge.
--   overpayment Returning money that was never owed. No credit — the balance
--               was negative and returning the excess brings it to zero.
--               Capped at the amount actually overpaid.
--   correction  The charge should not have been taken THAT WAY (wrong card,
--               wrong customer) but the money is still owed. No credit; the
--               balance is restored deliberately and may be collected again.
--   dispute     The customer has disputed. Balance is restored, but
--               automatic collection is PAUSED on that invoice — charging a
--               card mid-dispute is how a chargeback becomes two.
--
-- A refund also has a lifecycle. 0006 wrote every refund as 'succeeded' the
-- moment it was recorded, so a refund that Stripe later failed had already
-- moved the money on our side. Refunds may now be recorded 'pending' and
-- settled when Stripe says so; only a succeeded refund touches the invoice.
-- ============================================================================

create type refund_kind as enum ('goodwill', 'overpayment', 'correction', 'dispute');

alter table refunds
  -- Defaulting to the kind that cannot create a charge. A dashboard refund
  -- arrives with no stated intent, and guessing "correction" would bill the
  -- customer for our own apology.
  add column kind refund_kind not null default 'goodwill';

comment on column refunds.kind is
  'What this refund means for what is owed. goodwill raises a matching '
  'credit so nothing becomes collectible; overpayment returns money never '
  'owed; correction and dispute deliberately restore the balance. See 0011.';

-- ------------------------------------------------------- adjustments ------
-- A decision not to collect something, as a row. Separate from the refund so
-- the audit trail says both things: cash went back, AND we wrote it off.
create table invoice_adjustments (
  id           uuid primary key default uuid_generate_v4(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  reason       text,
  -- Set when this credit exists because of a refund, which is the goodwill
  -- case. A credit raised on its own (a discount after the fact) has none.
  refund_id    uuid references refunds(id) on delete set null,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on invoice_adjustments (invoice_id);
create unique index invoice_adjustments_one_per_refund
  on invoice_adjustments (refund_id) where refund_id is not null;

alter table invoices add column credit_cents integer not null default 0;
alter table invoices add constraint invoices_credit_nonneg check (credit_cents >= 0);

-- Regenerating the balance means dropping and re-adding it; a generated
-- column's expression cannot be altered in place.
alter table invoices drop column balance_cents;
alter table invoices
  add column balance_cents integer
  generated always as (total_cents - credit_cents - amount_paid_cents + refunded_cents) stored;

-- Automatic collection, paused. Set when a refund is recorded as a dispute;
-- cleared only by a person deciding the matter is settled.
alter table invoices add column autocharge_paused_at timestamptz;
alter table invoices add column autocharge_paused_reason text;

alter table invoice_adjustments enable row level security;
create policy invoice_adjustments_admin_all on invoice_adjustments for all
  using (is_admin()) with check (is_admin());
-- A customer sees credits on their own invoices: a $50 credit is the
-- explanation for why a $170 clean shows as settled after $120.
create policy invoice_adjustments_own on invoice_adjustments for select using (
  exists (select 1 from invoices i
          where i.id = invoice_adjustments.invoice_id
            and i.customer_id = current_customer_id())
);

/**
 * Credit an invoice. The half of a refund that decides what is owed.
 *
 * Usable on its own — a discount agreed after the fact is a credit with no
 * refund behind it — which is why it is a function rather than something
 * record_refund does inline.
 */
create or replace function record_invoice_credit(
  p_invoice_id   uuid,
  p_amount_cents integer,
  p_reason       text default null,
  p_refund_id    uuid default null,
  p_created_by   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'a credit must be positive, got %', p_amount_cents;
  end if;

  perform 1 from invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice % not found', p_invoice_id; end if;

  -- One credit per refund. A replayed refund webhook must not credit twice.
  if p_refund_id is not null then
    select id into v_id from invoice_adjustments where refund_id = p_refund_id;
    if v_id is not null then return v_id; end if;
  end if;

  insert into invoice_adjustments (invoice_id, amount_cents, reason, refund_id, created_by)
  values (p_invoice_id, p_amount_cents, p_reason, p_refund_id, p_created_by)
  returning id into v_id;

  update invoices set credit_cents = credit_cents + p_amount_cents
  where id = p_invoice_id;

  perform resettle_invoice(p_invoice_id);
  return v_id;
end $$;

-- The 0006 signature is replaced rather than extended in place: the kind and
-- the status are not optional trailing detail, they are the decision.
drop function if exists record_refund(text, integer, text, uuid, text);

/**
 * Record a refund against the payment that took the money.
 *
 * Returns NULL when the Stripe refund id has already been recorded.
 *
 * A refund recorded as 'pending' touches nothing but the audit trail until
 * `settle_refund` says Stripe finished it. 0006 wrote every refund straight
 * to 'succeeded', so a refund Stripe later declined had already moved the
 * money here.
 */
create or replace function record_refund(
  p_stripe_payment_intent_id text,
  p_amount_cents             integer,
  p_stripe_refund_id         text default null,
  p_requested_by             uuid default null,
  p_reason                   text default null,
  p_kind                     refund_kind default 'goodwill',
  p_status                   refund_status default 'succeeded'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_payment    payments%rowtype;
  v_refund_id  uuid;
  v_refundable integer;
begin
  if p_amount_cents <= 0 then
    raise exception 'refund amount must be positive, got %', p_amount_cents;
  end if;
  if p_status not in ('pending', 'succeeded') then
    raise exception 'a refund cannot be recorded as %', p_status;
  end if;

  if p_stripe_refund_id is not null and exists (
       select 1 from refunds where stripe_refund_id = p_stripe_refund_id) then
    return null;
  end if;

  select * into v_payment from payments
  where stripe_payment_intent_id = p_stripe_payment_intent_id;

  if v_payment.id is null then
    raise exception 'no payment for payment_intent %', p_stripe_payment_intent_id;
  end if;

  perform 1 from invoices where id = v_payment.invoice_id for update;

  -- Refundable against THIS payment, not against the invoice as a whole.
  -- Pending refunds count against it: the money is on its way back.
  select v_payment.amount_cents - coalesce(sum(amount_cents), 0) into v_refundable
  from refunds where payment_id = v_payment.id and status in ('pending', 'succeeded');

  if p_amount_cents > v_refundable then
    raise exception 'cannot refund %: only % of % remains unrefunded',
      p_amount_cents, v_refundable, v_payment.amount_cents;
  end if;

  insert into refunds (payment_id, amount_cents, reason, status, kind,
                       stripe_refund_id, requested_by, succeeded_at)
  values (v_payment.id, p_amount_cents, p_reason, p_status, p_kind,
          p_stripe_refund_id, p_requested_by,
          case when p_status = 'succeeded' then now() end)
  returning id into v_refund_id;

  if p_status = 'succeeded' then
    perform apply_refund_effects(v_refund_id);
  end if;

  return v_refund_id;
end $$;

/**
 * Move the money for a refund that has succeeded.
 *
 * Separated from recording so that a refund which starts pending and
 * succeeds later takes exactly the same path as one that succeeded at once.
 * Idempotent: the caller is a webhook.
 */
create or replace function apply_refund_effects(p_refund_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_refund     refunds%rowtype;
  v_invoice_id uuid;
  v_overpaid   integer;
begin
  select * into v_refund from refunds where id = p_refund_id;
  if v_refund.id is null then
    raise exception 'refund % not found', p_refund_id;
  end if;
  if v_refund.status <> 'succeeded' then
    raise exception 'refund % is %, not succeeded', p_refund_id, v_refund.status;
  end if;

  select invoice_id into v_invoice_id from payments where id = v_refund.payment_id;
  perform 1 from invoices where id = v_invoice_id for update;

  -- Gross refunded always moves. This is the reporting half, and it is the
  -- part 0006 got right: a refunded job must still show its real revenue.
  update invoices set refunded_cents = refunded_cents + v_refund.amount_cents
  where id = v_invoice_id;

  if v_refund.kind = 'goodwill' then
    -- The collection half. A gesture must not become an amount owed, so a
    -- matching credit cancels the balance the refund would otherwise restore.
    perform record_invoice_credit(
      v_invoice_id, v_refund.amount_cents,
      coalesce(v_refund.reason, 'goodwill refund'), v_refund.id, v_refund.requested_by);

  elsif v_refund.kind = 'overpayment' then
    -- Returning money never owed. The balance BEFORE this refund was
    -- negative by at least this much, or there was no overpayment to return.
    select greatest(0, -(total_cents - credit_cents - amount_paid_cents
                         + refunded_cents - v_refund.amount_cents))
      into v_overpaid
    from invoices where id = v_invoice_id;

    if v_refund.amount_cents > v_overpaid then
      raise exception
        'cannot return % as an overpayment: only % was overpaid. Use goodwill '
        'or correction if this is not a returned overpayment',
        v_refund.amount_cents, v_overpaid;
    end if;

  elsif v_refund.kind = 'dispute' then
    -- Restores the balance, like a correction, but nothing automatic may
    -- touch it: charging a card mid-dispute turns one chargeback into two.
    update invoices set
      autocharge_paused_at = coalesce(autocharge_paused_at, now()),
      autocharge_paused_reason = coalesce(autocharge_paused_reason, 'refund recorded as a dispute')
    where id = v_invoice_id;
  end if;
  -- 'correction' falls through: balance restored, deliberately collectible.

  perform resettle_invoice(v_invoice_id);
end $$;

/**
 * Tell us how a pending refund ended.
 *
 * Succeeded applies the effects that recording deferred. Failed or canceled
 * applies nothing — which is the point of having recorded it pending.
 */
create or replace function settle_refund(
  p_stripe_refund_id text,
  p_status           refund_status
) returns text
language plpgsql security definer set search_path = public as $$
declare v_refund refunds%rowtype;
begin
  select * into v_refund from refunds where stripe_refund_id = p_stripe_refund_id;
  if v_refund.id is null then return 'unknown'; end if;

  -- Already settled. A webhook replay, and a no-op.
  if v_refund.status = p_status then return 'unchanged'; end if;

  if v_refund.status <> 'pending' then
    -- Stripe does not un-succeed a refund; if it appears to, that is worth a
    -- person looking rather than money moving twice.
    raise exception 'refund % is already %, refusing to make it %',
      p_stripe_refund_id, v_refund.status, p_status;
  end if;

  if p_status = 'succeeded' then
    update refunds set status = 'succeeded', succeeded_at = now() where id = v_refund.id;
    perform apply_refund_effects(v_refund.id);
    return 'succeeded';
  end if;

  update refunds set status = p_status where id = v_refund.id;
  return p_status::text;
end $$;

/** Lift a collection pause. A person's decision, never automatic. */
create or replace function resume_invoice_autocharge(p_invoice_id uuid)
returns void
language sql security definer set search_path = public as $$
  update invoices
    set autocharge_paused_at = null, autocharge_paused_reason = null
  where id = p_invoice_id;
$$;

revoke all on function record_refund(text, integer, text, uuid, text, refund_kind, refund_status)
  from public, anon, authenticated;
revoke all on function record_invoice_credit(uuid, integer, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function apply_refund_effects(uuid) from public, anon, authenticated;
revoke all on function settle_refund(text, refund_status) from public, anon, authenticated;
revoke all on function resume_invoice_autocharge(uuid) from public, anon, authenticated;

grant execute on function record_refund(text, integer, text, uuid, text, refund_kind, refund_status)
  to service_role;
grant execute on function record_invoice_credit(uuid, integer, text, uuid, uuid) to service_role;
grant execute on function apply_refund_effects(uuid) to service_role;
grant execute on function settle_refund(text, refund_status) to service_role;
grant execute on function resume_invoice_autocharge(uuid) to service_role;
