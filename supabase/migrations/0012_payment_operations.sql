-- ============================================================================
-- 0012 — payment operations: collecting each obligation at most once
--
-- Two gaps, and they are the same gap seen from different sides.
--
-- FIRST: nothing recorded that a collection attempt was IN FLIGHT. Checkout
-- created a Stripe session and returned a URL; the auto-charge sweep created
-- a payment intent. Neither left a durable trace until the webhook landed and
-- a payment row appeared. So between "Stripe has been asked for money" and
-- "we know what happened" there was no state at all, and anything that
-- consulted the invoice saw an unpaid invoice and started again:
--
--   * two Checkout tabs -> two sessions, two chargeable pages;
--   * a customer paying through Checkout while the nightly sweep runs ->
--     a session AND an off-session charge for the same balance;
--   * a customer clicking Pay twice -> the same.
--
--   The Stripe-side idempotency key saved the sweep from charging the same
--   ATTEMPT twice. It does nothing across channels, and nothing for Checkout,
--   which had no key at all.
--
-- SECOND: a declined payment and an unknown one were treated identically. If
-- Stripe succeeded but the response was lost, or the process died before the
-- write, the invoice still read as unpaid — and the next attempt collected
-- the same money again. "We do not know" is not "it failed", and the only
-- safe response to it is to go and ask Stripe before touching the card again.
--
-- A payment operation is the missing record: created BEFORE Stripe is called,
-- carrying the idempotency key and, once known, the Stripe object it became.
-- It is what makes "is something already being collected here?" answerable,
-- and what gives reconciliation something to reconcile.
--
-- The invariant:
--
--     At most one open operation per invoice. A second collection attempt
--     must either join the existing one or be refused — never start a
--     parallel one.
-- ============================================================================

create type payment_operation_channel as enum ('checkout', 'autocharge');
create type payment_operation_state as enum ('open', 'succeeded', 'failed', 'abandoned');

create table payment_operations (
  id           uuid primary key default uuid_generate_v4(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  channel      payment_operation_channel not null,
  -- Sent to Stripe as the Idempotency-Key AND unique here, so the same
  -- obligation cannot produce two operations even across processes.
  idempotency_key text not null unique,
  state        payment_operation_state not null default 'open',
  amount_cents integer not null check (amount_cents > 0),
  -- Filled in once Stripe has answered. Null between creating the row and
  -- getting a reply — which is exactly the window that used to be invisible,
  -- and is why the row is written first.
  stripe_object_id   text,
  stripe_object_kind text check (stripe_object_kind in ('checkout_session', 'payment_intent')),
  -- Where to send a customer who is mid-Checkout, so a second tab joins the
  -- session that already exists instead of opening another.
  redirect_url text,
  /**
   * When this operation stops holding the invoice.
   *
   * Without it a process that died between creating the row and calling
   * Stripe would block that invoice from ever being collected again. It is a
   * backstop, NOT the mechanism: the checkout route reconciles with Stripe
   * before starting anything, so a real payment behind a stale operation is
   * found rather than timed out.
   */
  expires_at   timestamptz not null,
  last_error   text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  constraint payment_operations_resolved_state
    check ((state = 'open') = (resolved_at is null))
);

create index on payment_operations (invoice_id, created_at desc);
-- The invariant, in the schema. Two collection attempts cannot both be open
-- on one invoice, whichever channel they came from.
create unique index payment_operations_one_open
  on payment_operations (invoice_id) where state = 'open';

alter table payment_operations enable row level security;
create policy payment_operations_admin_all on payment_operations for all
  using (is_admin()) with check (is_admin());
-- A customer sees their own, so "you already have a payment in progress" is
-- something the screen can show rather than an opaque refusal.
create policy payment_operations_own on payment_operations for select using (
  exists (select 1 from invoices i
          where i.id = payment_operations.invoice_id
            and i.customer_id = current_customer_id())
);

/**
 * Start a collection attempt, or find out why we may not.
 *
 * Returns one row:
 *
 *   outcome 'started'  — this operation is ours; call Stripe.
 *   outcome 'existing' — this exact idempotency key is already open. The
 *                        second of two identical tabs lands here, and gets
 *                        the SAME Stripe session back rather than a new one.
 *   outcome 'blocked'  — a different attempt is open on this invoice. The
 *                        caller must reconcile it before collecting again.
 *
 * Expired open operations are abandoned rather than allowed to block
 * forever. That is a backstop: callers reconcile with Stripe first, so a
 * payment that actually went through is found before this ever applies.
 */
create or replace function begin_payment_operation(
  p_invoice_id      uuid,
  p_channel         payment_operation_channel,
  p_idempotency_key text,
  p_amount_cents    integer,
  p_ttl_seconds     integer default 900
) returns table (
  outcome        text,
  operation_id   uuid,
  channel        payment_operation_channel,
  idempotency_key text,
  stripe_object_id   text,
  stripe_object_kind text,
  redirect_url   text,
  amount_cents   integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_open payment_operations%rowtype;
  v_outcome text;
begin
  if p_amount_cents <= 0 then
    raise exception 'a collection attempt must be for a positive amount, got %', p_amount_cents;
  end if;

  -- Serialise every decision about this invoice's collection on the invoice
  -- row. Two tabs arriving together is the ordinary case, not the exotic one.
  perform 1 from invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice % not found', p_invoice_id; end if;

  -- Time out an operation nobody is coming back for. Table-qualified
  -- throughout: this function's OUT parameters share names with the table's
  -- columns, and an unqualified reference is ambiguous.
  update payment_operations po set
    state = 'abandoned', resolved_at = clock_timestamp(),
    last_error = coalesce(po.last_error, 'no outcome before the operation expired')
  -- clock_timestamp(), not now(): now() is the TRANSACTION's start time and
  -- does not advance within it, so an expiry compared against it can never be
  -- observed to pass from inside a long statement. Expiry is wall clock.
  where po.invoice_id = p_invoice_id and po.state = 'open'
    and po.expires_at <= clock_timestamp();

  select po.* into v_open from payment_operations po
  where po.invoice_id = p_invoice_id and po.state = 'open';

  if v_open.id is null then
    -- A key that has already been used and resolved is not a fresh attempt.
    -- Repeated submissions of the same form land here after the first one
    -- finished, and must not collect a second time.
    select po.* into v_open from payment_operations po
    where po.idempotency_key = p_idempotency_key;
    if v_open.id is not null then v_outcome := 'existing'; end if;
  elsif v_open.idempotency_key = p_idempotency_key then
    v_outcome := 'existing';
  else
    v_outcome := 'blocked';
  end if;

  if v_outcome is null then
    insert into payment_operations as po
      (invoice_id, channel, idempotency_key, amount_cents, expires_at)
    values (p_invoice_id, p_channel, p_idempotency_key, p_amount_cents,
            clock_timestamp() + make_interval(secs => p_ttl_seconds))
    returning po.* into v_open;
    v_outcome := 'started';
  end if;

  return query select v_outcome, v_open.id, v_open.channel, v_open.idempotency_key,
                      v_open.stripe_object_id, v_open.stripe_object_kind,
                      v_open.redirect_url, v_open.amount_cents;
end $$;

/**
 * Record what Stripe object an operation became, and where to send the
 * customer. Called the moment Stripe answers, so the window in which we have
 * asked for money and cannot say what we asked for is as short as possible.
 */
create or replace function attach_payment_operation(
  p_idempotency_key   text,
  p_stripe_object_kind text,
  p_stripe_object_id  text,
  p_redirect_url      text default null,
  p_expires_at        timestamptz default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  update payment_operations po set
    stripe_object_kind = p_stripe_object_kind,
    stripe_object_id   = p_stripe_object_id,
    redirect_url       = coalesce(p_redirect_url, po.redirect_url),
    expires_at         = coalesce(p_expires_at, po.expires_at)
  where po.idempotency_key = p_idempotency_key and po.state = 'open';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

/**
 * Close a collection attempt.
 *
 * 'failed' means Stripe told us it failed — a decline. It is NOT the answer
 * to "the request timed out", which is what `abandoned` after reconciliation
 * is for. Conflating the two is what let an uncertain outcome be retried as
 * though it were a known decline.
 */
create or replace function resolve_payment_operation(
  p_idempotency_key text,
  p_state           payment_operation_state,
  p_error           text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  if p_state = 'open' then
    raise exception 'resolving an operation to open is not a resolution';
  end if;

  update payment_operations po set
    state       = p_state,
    resolved_at = clock_timestamp(),
    last_error  = coalesce(p_error, po.last_error)
  where po.idempotency_key = p_idempotency_key and po.state = 'open';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

/**
 * Close whatever operation a settled payment belongs to.
 *
 * Called after `record_payment`, by reference rather than by key, because the
 * webhook knows the Stripe object (a session or an intent) and not
 * necessarily the key we used. Safe to call for a payment with no operation
 * behind it — plenty of payments predate this table.
 */
create or replace function settle_payment_operation_by_ref(
  p_invoice_id uuid,
  p_ref        text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  if p_ref is null then return false; end if;

  update payment_operations po set
    state = 'succeeded', resolved_at = clock_timestamp()
  where po.invoice_id = p_invoice_id and po.state = 'open' and po.stripe_object_id = p_ref;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

/** The open operation on an invoice, if there is one. */
create or replace function open_payment_operation(p_invoice_id uuid)
returns payment_operations
language sql stable security definer set search_path = public as $$
  select * from payment_operations
  where invoice_id = p_invoice_id and state = 'open' and expires_at > clock_timestamp()
  limit 1;
$$;

revoke all on function begin_payment_operation(uuid, payment_operation_channel, text, integer, integer)
  from public, anon, authenticated;
revoke all on function attach_payment_operation(text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function resolve_payment_operation(text, payment_operation_state, text)
  from public, anon, authenticated;
revoke all on function settle_payment_operation_by_ref(uuid, text)
  from public, anon, authenticated;
revoke all on function open_payment_operation(uuid) from public, anon, authenticated;

grant execute on function begin_payment_operation(uuid, payment_operation_channel, text, integer, integer)
  to service_role;
grant execute on function attach_payment_operation(text, text, text, text, timestamptz) to service_role;
grant execute on function resolve_payment_operation(text, payment_operation_state, text) to service_role;
grant execute on function settle_payment_operation_by_ref(uuid, text) to service_role;
grant execute on function open_payment_operation(uuid) to service_role;
