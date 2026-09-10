-- ============================================================================
-- 0009 — saved cards: keeping the default card default
--
-- The bug this replaces, in full, because the shape of it matters:
--
--   `saveCard` decided "is this the customer's first card?" by counting their
--   other undetached cards, and wrote `is_default = <that answer>` on every
--   upsert. With one card on file the answer was right. With two it was not:
--
--     * Card A is saved and becomes the default.
--     * Card B is saved; A already exists, so B is written non-default. Good.
--     * Stripe redelivers A's `payment_method.attached` — it retries for three
--       days and this is an ordinary occurrence, not a fault.
--     * The count now finds B, so A is "not first", and the upsert writes
--       is_default = false over the customer's ONLY default.
--
--   The customer still has two saved cards. Autopay still reads as on. And
--   `listAutochargeCandidates`, which joins on `is_default`, quietly stops
--   finding them — so the invoices simply never get charged and nothing
--   anywhere says why.
--
-- The rule the code was reaching for is not "is this the first card" but
-- "does this customer have a default at all". Restated as an invariant:
--
--     Saving a card NEVER changes which card is the default, except when
--     there is no default to change.
--
-- That is decided here rather than in TypeScript because it is a
-- read-modify-write across two rows and two deliveries can arrive at once.
-- Under a lock on the customer row it is one decision; in the application it
-- was two clients racing, with a partial unique index to lose against.
-- ============================================================================

-- Where a suspended autopay is recorded. Detaching the last card leaves a
-- customer who has consented, wants to be charged, and cannot be — and until
-- now that state was invisible: the sweep skipped them with `no_card` and no
-- trace was left on the customer at all.
alter table customers
  add column autopay_suspended_at     timestamptz,
  add column autopay_suspended_reason text;

comment on column customers.autopay_suspended_at is
  'Set when autopay is consented to but cannot run — currently, no card on '
  'file. Consent (autopay_authorized_at) is deliberately NOT cleared, so '
  'adding a card resumes autopay without asking the customer to opt in again.';

/**
 * Mirror a card Stripe has attached.
 *
 * Idempotent by construction: called twice with the same payment method, the
 * second call updates metadata and leaves `is_default` exactly as it found it.
 *
 * Returns true if this card is the default after the call.
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
  -- The lock. Every default-card decision for this customer serialises on
  -- their row, so two deliveries landing together cannot both conclude
  -- "nobody is default yet" and race for the partial unique index.
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
    -- A card we already hold. This is the replay path, and the ONLY correct
    -- thing to do with its default flag is leave it alone — unless the
    -- customer has no default at all, in which case re-attaching this one
    -- restores it rather than leaving autopay stranded.
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
    -- A new card. It becomes the default only if there is not one already,
    -- which is what makes the first card chargeable without a second step and
    -- the second card not steal the position.
    v_is_default := not v_has_default;

    insert into payment_methods (
      customer_id, stripe_payment_method_id, brand, last4,
      exp_month, exp_year, is_default
    ) values (
      p_customer_id, p_stripe_payment_method_id, p_brand, p_last4,
      p_exp_month, p_exp_year, v_is_default
    );
  end if;

  -- A card on file clears a suspension. Consent was never withdrawn, so
  -- autopay simply resumes.
  if v_is_default then
    update customers
      set autopay_suspended_at = null, autopay_suspended_reason = null
    where id = p_customer_id and autopay_suspended_at is not null;
  end if;

  return v_is_default;
end $$;

/**
 * Detach a card, and decide what happens to autopay.
 *
 * Detached rather than deleted: a payment row must still be able to name the
 * card it was taken on.
 *
 * The question this answers, which was previously unanswered: when the DEFAULT
 * card is removed, what charges the next invoice? Leaving the customer with
 * saved cards, autopay switched on and no default is the worst of the
 * available answers, because everything on screen says they are set up.
 *
 * The policy, stated once and implemented only here:
 *
 *   * another undetached card exists -> the oldest becomes the default, since
 *     it is the one they have had longest and most likely still works;
 *   * no card remains and autopay is on -> autopay is SUSPENDED, not
 *     cancelled. Consent stands, the reason is recorded on the customer, and
 *     saving any card resumes it.
 *
 * Returns the stripe id of the card now default, or null if there is none.
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

  -- Detaching a card we never mirrored is a no-op, not an error: Stripe will
  -- happily tell us about a payment method that predates this table.
  if v_card.id is null then return null; end if;

  perform 1 from customers where id = v_card.customer_id for update;

  update payment_methods
    set detached_at = coalesce(detached_at, now()), is_default = false
  where id = v_card.id;

  -- Only the default's removal needs a successor chosen.
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

  update customers set
    autopay_suspended_at = now(),
    autopay_suspended_reason = 'the last saved card was removed'
  where id = v_card.customer_id and autopay_enabled and autopay_suspended_at is null;

  return null;
end $$;

-- Server-side only, in the posture 0007 established.
revoke all on function save_payment_method(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function detach_payment_method(text) from public, anon, authenticated;
grant execute on function save_payment_method(uuid, text, text, text, integer, integer)
  to service_role;
grant execute on function detach_payment_method(text) to service_role;
