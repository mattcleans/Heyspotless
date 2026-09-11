-- ============================================================================
-- 0013 — two policy decisions from Matt and Maddie (11 Sep 2026)
--
-- 1. A REFUND OF UNKNOWN INTENT IS NOT ALL GOODWILL.
--
--    0011 recorded a refund issued from the Stripe dashboard as `goodwill` —
--    a full credit, never re-collected. The money half of that was right and
--    stays. The ATTRIBUTION was wrong: treating every unexplained refund as a
--    gesture of generosity hides the ones that were actually a service
--    failure, and service failures are what a marketplace has to be able to
--    see. If the books say "goodwill" every time, nobody ever learns which
--    cleans went wrong.
--
--    So an unattributed refund is now split 50/50 — half "service refund to
--    customer", half goodwill — as a stated default in the absence of better
--    information. It is still 100% credited and still never re-collected;
--    what changes is only which bucket the business reads it in.
--
--    `service_refund` also becomes a kind an admin can choose outright, for
--    when they KNOW the clean was the problem. That is the number that should
--    drive quality work, so it must not be diluted by guesses.
--
-- 2. NO CARD MEANS NO CONSENT.
--
--    0009 kept autopay consent alive when the last card was detached, and
--    merely paused collection, so adding a card resumed it without asking.
--    Convenient, and wrong: an authorisation to charge a card the customer
--    has removed is a stale authorisation, and "they agreed eight months ago,
--    before they deleted the card" is not a position to defend a dispute
--    from. Removing the last card now WITHDRAWS consent. Adding a card later
--    is a new decision, and the customer makes it.
-- ============================================================================

-- --------------------------------------------------- 1. attribution -------

alter type refund_kind add value if not exists 'service_refund';
alter type refund_kind add value if not exists 'unattributed';

/**
 * What a credit is FOR.
 *
 * The money effect of every category is identical — a credit reduces what is
 * collectible, full stop. This exists so the business can tell a clean that
 * went wrong from a gesture, and a discount from either.
 */
create type adjustment_category as enum (
  'service_refund',   -- the work was not right
  'goodwill',         -- the work was fine; we chose to give something back
  'discount',         -- agreed before or after the fact, not a failure
  'correction'        -- a billing mistake of ours
);

alter table invoice_adjustments
  add column category adjustment_category not null default 'goodwill';

-- One credit per refund becomes one credit per refund PER CATEGORY, because
-- an unattributed refund now raises two. Still exactly one of each, so a
-- replayed webhook cannot credit twice.
drop index invoice_adjustments_one_per_refund;
create unique index invoice_adjustments_one_per_refund_category
  on invoice_adjustments (refund_id, category) where refund_id is not null;

comment on column invoice_adjustments.category is
  'What the credit is for. Every category has the same effect on what is '
  'collectible; the distinction is for reporting — see docs/money-policy.md.';

/**
 * How an unattributed refund is split.
 *
 * A stated default, not a measurement. Kept as a function so there is one
 * place to change it when there is real data about how often an unexplained
 * refund turns out to be a service failure.
 */
create or replace function unattributed_service_share() returns numeric
language sql immutable set search_path = public as $$ select 0.5::numeric $$;

-- Replaced rather than overloaded: 0011's five-argument version would still
-- match a three-argument call, and "function is not unique" at runtime is a
-- poor way to find that out.
drop function if exists record_invoice_credit(uuid, integer, text, uuid, uuid);

create or replace function record_invoice_credit(
  p_invoice_id   uuid,
  p_amount_cents integer,
  p_reason       text default null,
  p_refund_id    uuid default null,
  p_created_by   uuid default null,
  p_category     adjustment_category default 'goodwill'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'a credit must be positive, got %', p_amount_cents;
  end if;

  perform 1 from invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice % not found', p_invoice_id; end if;

  -- One credit per refund per category. A replayed refund webhook must not
  -- credit twice.
  if p_refund_id is not null then
    select id into v_id from invoice_adjustments
    where refund_id = p_refund_id and category = p_category;
    if v_id is not null then return v_id; end if;
  end if;

  insert into invoice_adjustments (invoice_id, amount_cents, reason, refund_id,
                                   created_by, category)
  values (p_invoice_id, p_amount_cents, p_reason, p_refund_id, p_created_by, p_category)
  returning id into v_id;

  update invoices set credit_cents = credit_cents + p_amount_cents
  where id = p_invoice_id;

  perform resettle_invoice(p_invoice_id);
  return v_id;
end $$;

/**
 * Move the money for a refund that has succeeded. Unchanged from 0011 except
 * for how the credit is attributed.
 */
create or replace function apply_refund_effects(p_refund_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_refund     refunds%rowtype;
  v_invoice_id uuid;
  v_overpaid   integer;
  v_service    integer;
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

  -- Gross refunded always moves. The reporting half, unchanged: a refunded
  -- job must still show its real revenue.
  update invoices set refunded_cents = refunded_cents + v_refund.amount_cents
  where id = v_invoice_id;

  if v_refund.kind = 'unattributed' then
    -- Nobody said why. Credited in full so it can never become collectible,
    -- and split so the service-failure figure is neither zero nor inflated.
    -- The odd cent goes to goodwill: better to understate a clean's failures
    -- than to overstate them, since that number drives quality work.
    v_service := floor(v_refund.amount_cents * unattributed_service_share());

    if v_service > 0 then
      perform record_invoice_credit(
        v_invoice_id, v_service,
        coalesce(v_refund.reason, 'refund, cause not recorded'),
        v_refund.id, v_refund.requested_by, 'service_refund');
    end if;
    if v_refund.amount_cents - v_service > 0 then
      perform record_invoice_credit(
        v_invoice_id, v_refund.amount_cents - v_service,
        coalesce(v_refund.reason, 'refund, cause not recorded'),
        v_refund.id, v_refund.requested_by, 'goodwill');
    end if;

  elsif v_refund.kind = 'goodwill' then
    perform record_invoice_credit(
      v_invoice_id, v_refund.amount_cents,
      coalesce(v_refund.reason, 'goodwill refund'),
      v_refund.id, v_refund.requested_by, 'goodwill');

  elsif v_refund.kind = 'service_refund' then
    -- Someone looked and said the clean was the problem. Undiluted.
    perform record_invoice_credit(
      v_invoice_id, v_refund.amount_cents,
      coalesce(v_refund.reason, 'service refund'),
      v_refund.id, v_refund.requested_by, 'service_refund');

  elsif v_refund.kind = 'overpayment' then
    select greatest(0, -(total_cents - credit_cents - amount_paid_cents
                         + refunded_cents - v_refund.amount_cents))
      into v_overpaid
    from invoices where id = v_invoice_id;

    if v_refund.amount_cents > v_overpaid then
      raise exception
        'cannot return % as an overpayment: only % was overpaid. Use goodwill, '
        'service_refund or correction if this is not a returned overpayment',
        v_refund.amount_cents, v_overpaid;
    end if;

  elsif v_refund.kind = 'dispute' then
    update invoices set
      autocharge_paused_at = coalesce(autocharge_paused_at, now()),
      autocharge_paused_reason = coalesce(autocharge_paused_reason, 'refund recorded as a dispute')
    where id = v_invoice_id;
  end if;
  -- 'correction' falls through: balance restored, deliberately collectible.

  perform resettle_invoice(v_invoice_id);
end $$;

-- The default kind changes from goodwill to unattributed. Same money, honest
-- attribution: a refund nobody explained is recorded as exactly that.
alter table refunds alter column kind set default 'unattributed';

drop function if exists record_refund(text, integer, text, uuid, text, refund_kind, refund_status);

create or replace function record_refund(
  p_stripe_payment_intent_id text,
  p_amount_cents             integer,
  p_stripe_refund_id         text default null,
  p_requested_by             uuid default null,
  p_reason                   text default null,
  p_kind                     refund_kind default 'unattributed',
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

-- ------------------------------------------------------- 2. consent -------

-- The columns said "suspended", which meant "switched off but consent still
-- stands". That state no longer exists, so the names would be a lie. These
-- now record that WE turned autopay off and why, so the screen can explain
-- it rather than just showing "Off".
alter table customers rename column autopay_suspended_at to autopay_ended_at;
alter table customers rename column autopay_suspended_reason to autopay_ended_reason;

comment on column customers.autopay_ended_at is
  'Set when the SYSTEM turned autopay off — currently, the last saved card '
  'was removed. Consent is withdrawn with it: re-enabling is a fresh '
  'decision by the customer. Null when the customer turned it off themselves.';

/**
 * Detach a card, and decide what happens to autopay.
 *
 * Unchanged from 0009 except for the last-card case: consent is now
 * WITHDRAWN rather than held. An authorisation to charge a card the customer
 * has removed is stale, and stale consent is not a position to defend a
 * dispute from.
 */
create or replace function detach_payment_method(p_stripe_payment_method_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_card payment_methods%rowtype;
  v_next payment_methods%rowtype;
begin
  select * into v_card from payment_methods
  where stripe_payment_method_id = p_stripe_payment_method_id;

  if v_card.id is null then return null; end if;

  perform 1 from customers where id = v_card.customer_id for update;

  update payment_methods
    set detached_at = coalesce(detached_at, now()), is_default = false
  where id = v_card.id;

  if not v_card.is_default then
    select * into v_next from payment_methods
    where customer_id = v_card.customer_id and is_default and detached_at is null
    limit 1;
    return v_next.stripe_payment_method_id;
  end if;

  select * into v_next from payment_methods
  where customer_id = v_card.customer_id and detached_at is null
  order by created_at, id
  limit 1;

  if v_next.id is not null then
    update payment_methods set is_default = true where id = v_next.id;
    return v_next.stripe_payment_method_id;
  end if;

  -- No card left. Autopay off, consent withdrawn, reason recorded. The
  -- CHECK constraint from 0006 would refuse `enabled` with no timestamp
  -- anyway, which is the schema agreeing that the two travel together.
  update customers set
    autopay_enabled       = false,
    autopay_authorized_at = null,
    autopay_ended_at      = now(),
    autopay_ended_reason  = 'the last saved card was removed'
  where id = v_card.customer_id and autopay_enabled;

  return null;
end $$;

/**
 * Mirror a card Stripe has attached.
 *
 * Unchanged from 0009 except that saving a card no longer resurrects autopay.
 * Consent was withdrawn when the last card went; turning it back on is the
 * customer's decision to make again, through the UI, which is what writes a
 * fresh `autopay_authorized_at`.
 */
create or replace function save_payment_method(
  p_customer_id  uuid,
  p_stripe_payment_method_id text,
  p_brand        text default null,
  p_last4        text default null,
  p_exp_month    integer default null,
  p_exp_year     integer default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_existing payment_methods%rowtype;
  v_has_default boolean;
  v_is_default boolean;
begin
  perform 1 from customers where id = p_customer_id for update;

  select * into v_existing from payment_methods
  where stripe_payment_method_id = p_stripe_payment_method_id;

  select exists (
    select 1 from payment_methods
    where customer_id = p_customer_id
      and is_default
      and detached_at is null
      and stripe_payment_method_id <> p_stripe_payment_method_id
  ) into v_has_default;

  if v_existing.id is not null then
    v_is_default := v_existing.is_default or not v_has_default;

    update payment_methods set
      customer_id = p_customer_id,
      brand       = coalesce(p_brand, brand),
      last4       = coalesce(p_last4, last4),
      exp_month   = coalesce(p_exp_month, exp_month),
      exp_year    = coalesce(p_exp_year, exp_year),
      is_default  = v_is_default,
      detached_at = null
    where id = v_existing.id;
  else
    v_is_default := not v_has_default;

    insert into payment_methods (
      customer_id, stripe_payment_method_id, brand, last4,
      exp_month, exp_year, is_default
    ) values (
      p_customer_id, p_stripe_payment_method_id, p_brand, p_last4,
      p_exp_month, p_exp_year, v_is_default
    );
  end if;

  return v_is_default;
end $$;

revoke all on function record_refund(text, integer, text, uuid, text, refund_kind, refund_status)
  from public, anon, authenticated;
revoke all on function record_invoice_credit(uuid, integer, text, uuid, uuid, adjustment_category)
  from public, anon, authenticated;
revoke all on function unattributed_service_share() from public, anon, authenticated;
grant execute on function record_refund(text, integer, text, uuid, text, refund_kind, refund_status)
  to service_role;
grant execute on function record_invoice_credit(uuid, integer, text, uuid, uuid, adjustment_category)
  to service_role;
grant execute on function unattributed_service_share() to service_role;
