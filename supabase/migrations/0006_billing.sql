-- ============================================================================
-- 0006 — billing: Stripe objects, saved cards, auto-charge and refunds
--
-- Build plan phase 03 ("Money"). 0001 already created `invoices`, `payments`
-- and `payouts` with the Stripe id columns, on the plan's principle that
-- "Stripe objects are mirrored locally so reporting never depends on an API
-- call". This migration adds everything that mirroring actually needs:
--
--   * the customer <-> Stripe customer link, and autopay CONSENT
--   * saved cards, stored as brand/last4/expiry only — never a card number
--   * refunds as first-class rows, because a refund is an event with a date
--     and an author, not a smaller number written over the original
--   * `stripe_events`, whose primary key is the whole idempotency strategy
--
-- MONEY INVARIANT, and the reason for the generated column below. Three
-- numbers describe an invoice and they must never be reconciled by hand:
--
--     amount_paid_cents  gross successfully captured
--     refunded_cents     gross refunded, always <= amount_paid_cents
--     balance_cents      total_cents - amount_paid_cents + refunded_cents
--
-- A refund therefore RESTORES balance rather than shrinking the invoice, which
-- is what makes a refunded job still show its real revenue in reporting. The
-- balance is generated in the database so `lib/billing/amounts.ts` and SQL can
-- never drift; the TypeScript is tested against these exact semantics.
-- ============================================================================

create type payment_status as enum ('requires_payment', 'processing', 'succeeded',
                                    'failed', 'canceled');
create type refund_status  as enum ('pending', 'succeeded', 'failed', 'canceled');

-- ------------------------------------------------------------ customers ---
alter table customers
  add column stripe_customer_id    text unique,
  -- Opt-in, and never defaulted on. Charging a card on file without recorded
  -- consent is the dispute every field-service business loses.
  add column autopay_enabled       boolean not null default false,
  add column autopay_authorized_at timestamptz;

-- The timestamp is the evidence. Enabling autopay without it is not allowed.
alter table customers
  add constraint customers_autopay_needs_consent
  check (not autopay_enabled or autopay_authorized_at is not null);

-- -------------------------------------------------------- payment methods --
-- Card metadata ONLY. The card itself lives at Stripe and is referenced by
-- token; nothing here is card data under PCI, which is the entire point of
-- Checkout and SetupIntents.
create table payment_methods (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   uuid not null references customers(id) on delete cascade,
  stripe_payment_method_id text not null unique,
  brand         text,
  last4         text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  exp_month     integer check (exp_month between 1 and 12),
  exp_year      integer check (exp_year between 2000 and 2100),
  is_default    boolean not null default false,
  -- Detached rather than deleted: a payment row must still be able to name the
  -- card it was taken on after the customer removes it.
  detached_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index on payment_methods (customer_id) where detached_at is null;

-- At most one default card per customer, enforced in the database so a race
-- between two "make this my default" clicks cannot leave two.
create unique index payment_methods_one_default
  on payment_methods (customer_id) where is_default and detached_at is null;

-- --------------------------------------------------------------- invoices --
alter table invoices
  add column stripe_checkout_session_id text unique,
  add column refunded_cents  integer not null default 0,
  add column issued_at       timestamptz,
  add column voided_at       timestamptz,
  -- Auto-charge bookkeeping. attempt_count is what makes the retry schedule
  -- and the Stripe idempotency key deterministic (lib/billing/autocharge.ts).
  add column attempt_count   integer not null default 0,
  add column last_attempt_at timestamptz,
  add column next_attempt_at timestamptz,
  add column last_error      text;

alter table invoices
  add constraint invoices_amounts_nonneg
    check (subtotal_cents >= 0 and tip_cents >= 0 and total_cents >= 0
           and amount_paid_cents >= 0 and refunded_cents >= 0),
  add constraint invoices_refund_within_paid
    check (refunded_cents <= amount_paid_cents),
  add constraint invoices_attempts_nonneg
    check (attempt_count >= 0);

alter table invoices
  add column balance_cents integer
  generated always as (total_cents - amount_paid_cents + refunded_cents) stored;

-- The auto-charge sweep's working set. Partial so it stays small no matter how
-- many paid invoices accumulate.
create index invoices_due_for_autocharge
  on invoices (next_attempt_at)
  where status in ('sent', 'overdue') and voided_at is null;

-- --------------------------------------------------------------- payments --
alter table payments
  add column customer_id  uuid references customers(id) on delete cascade,
  add column payment_method_id uuid references payment_methods(id) on delete set null,
  add column status       payment_status not null default 'succeeded',
  add column stripe_charge_id text unique,
  add column failure_code    text,
  add column failure_message text,
  add column is_autocharge   boolean not null default false,
  -- Sent to Stripe as the Idempotency-Key. Unique here as well, so a duplicated
  -- cron run cannot even record a second attempt, let alone make one.
  add column idempotency_key text unique;

alter table payments
  add constraint payments_amount_positive check (amount_cents > 0);

create index on payments (customer_id, created_at desc);

-- ---------------------------------------------------------------- refunds --
create table refunds (
  id            uuid primary key default uuid_generate_v4(),
  payment_id    uuid not null references payments(id) on delete cascade,
  amount_cents  integer not null check (amount_cents > 0),
  reason        text,
  status        refund_status not null default 'pending',
  stripe_refund_id text unique,
  -- Who authorised it. A refund is an act by a person, and reporting has to be
  -- able to say which one.
  requested_by  uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  succeeded_at  timestamptz
);
create index on refunds (payment_id);
create index on refunds (status, created_at desc);

-- ---------------------------------------------------------- stripe events --
-- Webhook idempotency, and the audit trail for it.
--
-- Stripe guarantees AT LEAST ONCE delivery and retries for up to three days,
-- so every handler will eventually be invoked twice for the same event. The
-- primary key below is the defence: the handler inserts the event id FIRST and
-- a unique violation means "already seen, acknowledge and do nothing". No
-- application-level locking, no dedupe cache to get wrong.
create table stripe_events (
  id           text primary key,          -- Stripe's evt_… id, verbatim
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  outcome      text,                      -- 'applied' | 'ignored' | 'failed'
  error        text,
  payload      jsonb
);
create index on stripe_events (type, received_at desc);
create index on stripe_events (received_at desc) where processed_at is null;

-- ------------------------------------------------------------------ RLS ----
alter table payment_methods enable row level security;
alter table refunds         enable row level security;
alter table stripe_events   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['payment_methods', 'refunds', 'stripe_events'] loop
    execute format(
      'create policy %I on %I for all using (is_admin()) with check (is_admin())',
      t || '_admin_all', t);
  end loop;
end $$;

-- A customer sees their own cards. They never write this table directly —
-- cards arrive through the Stripe webhook on the service-role client — so
-- there is a select policy and deliberately no insert or update policy.
create policy payment_methods_own on payment_methods for select
  using (customer_id = current_customer_id());

-- Refunds are visible on the customer's own payments, so a refunded charge is
-- explicable from their invoice history rather than an unexplained delta.
create policy refunds_own on refunds for select using (
  exists (
    select 1 from payments p
    join invoices i on i.id = p.invoice_id
    where p.id = refunds.payment_id and i.customer_id = current_customer_id()
  )
);

-- stripe_events gets no non-admin policy at all. It holds raw provider
-- payloads and is written only by the service-role client.

-- ============================================================================
-- MONEY MUTATIONS
--
-- Applying a payment is read-modify-write, and the two writers — the Stripe
-- webhook and the auto-charge sweep — can land on the same invoice at the same
-- moment. Doing it in TypeScript would mean one read's total overwriting the
-- other's. So the increments happen here, under a row lock, and the routes only
-- ever call these.
--
-- security definer because the webhook runs as the service role with no user;
-- search_path is pinned so the definer rights cannot be redirected.
-- ============================================================================

/**
 * Record a successful capture and settle the invoice.
 *
 * Returns the new payment id, or NULL when this payment has already been
 * recorded — a replayed webhook, or a cron run that died after Stripe returned
 * but before we wrote. NULL means "already applied, do nothing", not an error.
 */
create or replace function record_payment(
  p_invoice_id               uuid,
  p_amount_cents             integer,
  p_tip_cents                integer default 0,
  p_stripe_payment_intent_id text default null,
  p_stripe_charge_id         text default null,
  p_idempotency_key          text default null,
  p_is_autocharge            boolean default false,
  p_method                   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer_id uuid;
  v_payment_id  uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'payment amount must be positive, got %', p_amount_cents;
  end if;

  -- The lock that serialises concurrent settlement of the same invoice.
  select customer_id into v_customer_id
  from invoices where id = p_invoice_id for update;

  if v_customer_id is null then
    raise exception 'invoice % not found', p_invoice_id;
  end if;

  -- Idempotency, checked under the lock. Either identifier having been seen
  -- before means this capture is already on the books.
  if p_stripe_payment_intent_id is not null and exists (
       select 1 from payments
       where stripe_payment_intent_id = p_stripe_payment_intent_id) then
    return null;
  end if;
  if p_idempotency_key is not null and exists (
       select 1 from payments where idempotency_key = p_idempotency_key) then
    return null;
  end if;

  insert into payments (
    invoice_id, customer_id, amount_cents, status, method,
    stripe_payment_intent_id, stripe_charge_id, idempotency_key,
    is_autocharge, succeeded_at
  ) values (
    p_invoice_id, v_customer_id, p_amount_cents, 'succeeded', p_method,
    p_stripe_payment_intent_id, p_stripe_charge_id, p_idempotency_key,
    p_is_autocharge, now()
  ) returning id into v_payment_id;

  -- Column references on the right-hand side are the OLD values, so this is
  -- new_total = subtotal + old_tip + added_tip.
  update invoices set
    tip_cents         = tip_cents + coalesce(p_tip_cents, 0),
    total_cents       = subtotal_cents + tip_cents + coalesce(p_tip_cents, 0),
    amount_paid_cents = amount_paid_cents + p_amount_cents,
    next_attempt_at   = null,
    last_error        = null
  where id = p_invoice_id;

  perform resettle_invoice(p_invoice_id);
  return v_payment_id;
end $$;

/**
 * Record a refund against the payment that took the money.
 *
 * Returns NULL when the Stripe refund id has already been recorded. Refunds
 * RESTORE the invoice balance rather than shrinking the invoice — see the
 * money invariant at the top of this file.
 */
create or replace function record_refund(
  p_stripe_payment_intent_id text,
  p_amount_cents             integer,
  p_stripe_refund_id         text default null,
  p_requested_by             uuid default null,
  p_reason                   text default null
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
  select v_payment.amount_cents - coalesce(sum(amount_cents), 0) into v_refundable
  from refunds where payment_id = v_payment.id and status <> 'failed';

  if p_amount_cents > v_refundable then
    raise exception 'cannot refund %: only % of % remains unrefunded',
      p_amount_cents, v_refundable, v_payment.amount_cents;
  end if;

  insert into refunds (payment_id, amount_cents, reason, status,
                       stripe_refund_id, requested_by, succeeded_at)
  values (v_payment.id, p_amount_cents, p_reason, 'succeeded',
          p_stripe_refund_id, p_requested_by, now())
  returning id into v_refund_id;

  update invoices set refunded_cents = refunded_cents + p_amount_cents
  where id = v_payment.invoice_id;

  perform resettle_invoice(v_payment.invoice_id);
  return v_refund_id;
end $$;

/**
 * A failed auto-charge attempt. Spending an attempt is what moves the invoice
 * along the retry schedule, so this is the only thing that increments the count
 * — a successful charge never does, which is what makes a crash between Stripe
 * returning and us writing safe to simply retry with the same key.
 */
create or replace function record_autocharge_failure(
  p_invoice_id      uuid,
  p_error           text,
  p_next_attempt_at timestamptz default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update invoices set
    attempt_count   = attempt_count + 1,
    last_attempt_at = now(),
    next_attempt_at = p_next_attempt_at,
    last_error      = p_error
  where id = p_invoice_id;

  perform resettle_invoice(p_invoice_id);
end $$;

/**
 * Bring `status` back in line with the money. Mirrors derivedStatus() in
 * lib/billing/amounts.ts exactly; both are tested against the same cases.
 * A draft or a voided invoice is a decision a person made and is left alone.
 */
create or replace function resettle_invoice(p_invoice_id uuid)
returns void
language sql security definer set search_path = public as $$
  update invoices set status = case
    when balance_cents <= 0 then 'paid'::invoice_status
    when due_on is not null and due_on < current_date then 'overdue'::invoice_status
    else 'sent'::invoice_status
  end
  where id = p_invoice_id
    and status not in ('draft', 'void')
    and voided_at is null;
$$;
