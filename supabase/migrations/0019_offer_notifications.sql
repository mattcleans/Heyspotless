-- ============================================================================
-- 0019 — tell the cleaner an offer exists
--
-- A2P 10DLC approval landed 14 September 2026, which unblocks this.
--
-- WHAT WAS BROKEN. 0015 built the offer lifecycle and 0018 priced it, and
-- between them a cleaner could accept work. Nothing ever told her there was
-- work to accept. The only way to find an offer was to open the app and
-- refresh it.
--
-- That is not a missing nicety, it is a broken loop, and the timings say why:
--
--   waterfall rung            8-15 minutes
--   exclusive hold, same-day  45 minutes
--   exclusive hold, <3 days   4 hours
--   exclusive hold, 3+ days   24 hours
--
-- Nobody answers an unannounced offer inside fifteen minutes. So every
-- waterfall rung expired unanswered, the job climbed to the ceiling, and landed
-- on a W-2 or nowhere — the escalation running to exhaustion every time, not
-- because the logic was wrong but because there was no one listening.
--
-- WHY THE IDEMPOTENCY IS A UNIQUE INDEX. The dispatch sweep runs hourly and is
-- deliberately safe to re-run: `record_offer` returns the offer already out
-- rather than writing a second one. A notification has no such natural
-- identity, so without a constraint a re-run texts her again, and again, about
-- a job she is already looking at. Texting a contractor four times about one
-- clean is how a platform gets muted, and a muted cleaner is an unreachable
-- one.
-- ============================================================================

-- ------------------------------------------------------------ messages -----
alter table messages
  -- What this message was ABOUT, where it was about an offer. The FK is the
  -- idempotency key: one notification per offer, for ever.
  add column offer_id uuid references offers(id) on delete cascade,
  -- Why it was sent. Kept as text rather than an enum because the automation
  -- engine will add kinds faster than migrations should be written, and
  -- nothing branches on it.
  add column kind text,
  -- Set when the provider accepted it. Null with a `failed_reason` means we
  -- tried and could not — which is the state that matters, because a cleaner
  -- who was never reached must not look like one who ignored us.
  add column delivered_at timestamptz,
  add column failed_reason text;

comment on column messages.offer_id is
  'The offer this message announced. Unique per kind while set -- the hourly '
  'dispatch sweep must not text a cleaner twice about one clean. See 0019.';

/**
 * ONE NOTIFICATION PER OFFER PER KIND.
 *
 * Per kind rather than per offer outright: announcing an offer and later
 * telling her it was withdrawn are two legitimate messages about the same row.
 * What must never happen is the same announcement twice.
 */
create unique index messages_one_per_offer_kind
  on messages (offer_id, kind) where offer_id is not null;

create index on messages (cleaner_id, sent_at desc);
-- The retry sweep's working set: tried, not delivered, not yet given up on.
create index on messages (sent_at) where delivered_at is null and failed_reason is null;

-- ------------------------------------------------------------ opt-out ------
/**
 * A cleaner who has replied STOP.
 *
 * Carrier rules make honouring this mandatory, but the reason to model it
 * properly is narrower: an unreachable cleaner must not be offered work. Sending
 * her an offer she cannot see starts a countdown she cannot answer, and it
 * expires teaching the ranking that she passed on work she was never shown.
 *
 * On `profiles` rather than `cleaners` because the phone number lives there,
 * and consent belongs with the number rather than with the role.
 */
alter table profiles
  add column sms_opted_out_at timestamptz,
  add column sms_opted_out_reason text;

comment on column profiles.sms_opted_out_at is
  'Set when this person replied STOP. Cleared when they reply START. A cleaner '
  'who cannot be reached is not offered work -- see 0019.';

/**
 * Record an outbound message, once.
 *
 * Returns the message id, or NULL when one of this kind already exists for this
 * offer — which the caller reads as "already told her, send nothing". Null is
 * the ordinary answer on every sweep after the first.
 */
create or replace function record_outbound_message(
  p_offer_id   uuid,
  p_kind       text,
  p_cleaner_id uuid,
  p_job_id     uuid,
  p_channel    message_channel,
  p_body       text,
  p_to_address text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into messages (
    channel, direction, cleaner_id, job_id, offer_id, kind, body, to_address
  ) values (
    p_channel, 'outbound', p_cleaner_id, p_job_id, p_offer_id, p_kind, p_body, p_to_address
  )
  on conflict (offer_id, kind) where offer_id is not null
  do nothing
  returning id into v_id;

  return v_id;
end $$;

/** Mark what the provider said. One or the other, never both. */
create or replace function settle_outbound_message(
  p_message_id  uuid,
  p_provider_id text,
  p_failed_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update messages set
    provider_id   = coalesce(p_provider_id, provider_id),
    delivered_at  = case when p_failed_reason is null then now() else null end,
    failed_reason = p_failed_reason
  where id = p_message_id;
end $$;

/** STOP. Idempotent — replying twice is not twice as opted out. */
create or replace function set_sms_opt_out(
  p_profile_id uuid,
  p_opted_out  boolean,
  p_reason     text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set
    sms_opted_out_at = case when p_opted_out then coalesce(sms_opted_out_at, now()) else null end,
    sms_opted_out_reason = case when p_opted_out then p_reason else null end
  where id = p_profile_id;
end $$;

-- ------------------------------------------------------- row level security
-- `messages` was enabled in 0003, which gave customers `messages_own` for their
-- own thread. Cleaners need the same for theirs, under its own name: a cleaner
-- may read what was sent TO her and nothing else. The body names a customer and
-- an address, so one cleaner reading another's offers is a privacy failure and
-- a marketplace one.
create policy messages_own_cleaner on messages for select
  using (cleaner_id = current_cleaner_id());

revoke all on function record_outbound_message(uuid, text, uuid, uuid, message_channel, text, text)
  from public, anon, authenticated;
revoke all on function settle_outbound_message(uuid, text, text) from public, anon, authenticated;
revoke all on function set_sms_opt_out(uuid, boolean, text) from public, anon, authenticated;

grant execute on function record_outbound_message(uuid, text, uuid, uuid, message_channel, text, text)
  to service_role;
grant execute on function settle_outbound_message(uuid, text, text) to service_role;
grant execute on function set_sms_opt_out(uuid, boolean, text) to service_role;
