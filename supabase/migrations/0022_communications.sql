-- ============================================================================
-- 0022 — the platform learns to listen
--
-- Phase 06. 0019 gave the platform a voice: it can tell a cleaner an offer
-- exists. It cannot hear a word back.
--
-- WHAT THAT COSTS. Three separate failures, all of them silent:
--
--   1. STOP DOES NOT WORK. `set_sms_opt_out` was written in 0019 and has never
--      had a caller, because nothing receives. A cleaner who replies STOP is
--      opted out at the carrier and nowhere else, so dispatch goes on believing
--      she is reachable, goes on writing her offers, and goes on counting the
--      ones she never saw against her acceptance rate. Carrier rules make
--      honouring STOP mandatory; the marketplace makes it urgent.
--
--   2. A CUSTOMER REPLYING IS SHOUTING INTO A DRAIN. "Can we move Tuesday to
--      Thursday" sent to the number that just texted them is, today, received
--      by Twilio and discarded. That is worse than having no number at all: the
--      customer has every reason to believe somebody read it.
--
--   3. NOTHING HAPPENS ON A SCHEDULE EXCEPT DISPATCH AND MONEY. Reminders, the
--      on-my-way text, the review request — the automations table has existed
--      since 0001 with nothing ever writing to it.
--
-- So this migration is three things: somewhere to put what comes in, a way to
-- work out who sent it, and a queue that fires the messages nobody is awake to
-- send.
--
-- WHAT IT IS NOT. It is not a chat product. There are no typing indicators, no
-- threads-as-first-class-objects, no unread counts kept in a second place that
-- can disagree with the first. A thread is "the messages with this person,
-- newest last", derived on read, which is the version that cannot drift.
-- ============================================================================

-- --------------------------------------------------------- schema level ----
/**
 * What migration level this database is at.
 *
 * Exists because a deployment and its database are two different things that
 * can silently disagree: Vercel ships on merge, `supabase db push` is somebody
 * running a command. Code that calls a function three migrations ahead of the
 * database fails at the first request, in production, with a PostgREST error
 * nobody is watching for.
 *
 * EVERY MIGRATION FROM HERE BUMPS THIS. The readiness endpoint reads it, so a
 * migration that forgets shows up as a deploy that appears to be behind.
 */
create or replace function app_schema_version() returns integer
language sql immutable as $$ select 22 $$;

grant execute on function app_schema_version() to service_role;

-- ------------------------------------------------------ phone matching -----
/**
 * A phone number reduced to the thing that identifies it.
 *
 * Twilio delivers E.164 (`+12145550143`). People type `(214) 555-0143`, and
 * the Housecall Pro export has both plus a few with extensions. Matching an
 * inbound message to a person by string equality therefore matches almost
 * nothing, and "almost nothing" is the failure mode where a customer's reply
 * lands in the system attached to nobody.
 *
 * Last ten digits, because that is what is stable across every format a North
 * American number arrives in. IMMUTABLE so it can be indexed — without the
 * index every inbound message is a sequential scan of the customer book.
 *
 * International numbers are out of scope, deliberately: the service area is
 * DFW. A number that is not ten digits normalises to itself, matches nothing,
 * and the message is still recorded — unattached, and visible in the inbox as
 * exactly that.
 */
create or replace function normalize_phone(p_phone text) returns text
language sql immutable as $$
  select case
    when p_phone is null then null
    when length(regexp_replace(p_phone, '\D', '', 'g')) >= 10
      then right(regexp_replace(p_phone, '\D', '', 'g'), 10)
    else regexp_replace(p_phone, '\D', '', 'g')
  end
$$;

create index profiles_phone_normalized  on profiles  (normalize_phone(phone));
create index customers_phone_normalized on customers (normalize_phone(phone));
create index leads_phone_normalized     on leads     (normalize_phone(phone));

-- -------------------------------------------------------- customer stop -----
/**
 * A customer who has replied STOP.
 *
 * 0019 put this on `profiles`, where a cleaner's number lives. Most customers
 * have no profile row at all — they are created by the office, they never sign
 * in, and their number is on `customers`. Consent belongs with the number, so
 * it goes in both places rather than one.
 */
alter table customers
  add column sms_opted_out_at timestamptz,
  add column sms_opted_out_reason text;

comment on column customers.sms_opted_out_at is
  'Set when this customer replied STOP. Reminders and review requests check it; '
  'a transactional reply to a message they sent us does not. See 0022.';

-- ------------------------------------------------------------ messages -----
/**
 * WHY A SECOND IDEMPOTENCY KEY, AND NOT A SECOND INDEX ON (thing, kind).
 *
 * 0019 keyed a notification on (offer_id, kind), which is exactly right for
 * offers and useless for everything else: a reminder is about a job, a review
 * request is about a job, a nudge is about a lead. Adding a partial unique
 * index per subject type means a new index every time the automation engine
 * learns a new message — and two of them overlapping the day a message is
 * about both a job and an offer.
 *
 * One text key instead, built by the caller from what the message is about:
 *
 *   job:<uuid>:reminder.day_before
 *   job:<uuid>:review.request
 *   lead:<uuid>:nudge.2
 *
 * The caller names the identity, the database enforces it, and a message with
 * no natural identity (a human typing a reply in the inbox) leaves it null and
 * is never deduplicated — which is correct, because saying the same thing
 * twice on purpose is a thing people do.
 */
alter table messages
  add column dedupe_key text,
  -- Which way an automated message was going, for the inbox's benefit: an
  -- inbound message from an unknown number still needs somewhere to sit.
  add column from_profile_id uuid references profiles(id) on delete set null;

create unique index messages_dedupe on messages (dedupe_key) where dedupe_key is not null;

/**
 * Twilio retries a webhook it did not get a 2xx from, and it is right to: the
 * alternative is losing a customer's reply because a deploy was mid-flight. The
 * cost is the same message arriving two or three times, and a thread that shows
 * "can we move Tuesday" three times is a thread nobody trusts.
 *
 * MessageSid is unique per message for the life of the account, so it is the
 * key. Partial because outbound rows only acquire a provider_id when the send
 * settles, and a NULL is not a duplicate of another NULL here or anywhere.
 */
create unique index messages_provider_id_unique
  on messages (provider_id) where provider_id is not null;

-- The inbox's working set: everything inbound nobody has read, newest first.
create index messages_unread_inbound on messages (sent_at desc)
  where direction = 'inbound' and read_at is null;

create index messages_customer_thread on messages (customer_id, sent_at desc);
create index messages_lead_thread on messages (lead_id, sent_at desc);

/**
 * Record an automated outbound message, once.
 *
 * The generalisation of 0019's `record_outbound_message`, which stays as it is
 * — dispatch is the hottest path in the system and there is no reason to make
 * it take a string key it does not need.
 *
 * Returns the message id, or NULL when this exact message has already been
 * recorded. NULL is the ordinary answer on every sweep after the first, and it
 * is what stops an hourly automation sweep reminding a customer about Tuesday
 * eleven times.
 *
 * Recorded BEFORE the provider is called, for the reason 0019 gives: a crash
 * between sending and recording leaves no row, and the next sweep sends again.
 */
create or replace function record_message(
  p_dedupe_key text,
  p_kind       text,
  p_channel    message_channel,
  p_body       text,
  p_to_address text,
  p_customer_id uuid default null,
  p_cleaner_id  uuid default null,
  p_lead_id     uuid default null,
  p_job_id      uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into messages (
    channel, direction, dedupe_key, kind, body, to_address,
    customer_id, cleaner_id, lead_id, job_id
  ) values (
    p_channel, 'outbound', p_dedupe_key, p_kind, p_body, p_to_address,
    p_customer_id, p_cleaner_id, p_lead_id, p_job_id
  )
  on conflict (dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_id;

  return v_id;
end $$;

/**
 * Record something that arrived.
 *
 * Returns the message id, or NULL when this provider id has already been
 * recorded — which the webhook reads as "already have it, answer 200 and do
 * nothing else". Answering anything but 200 to a duplicate is how a retry
 * storm starts.
 *
 * ATTACHMENT IS BEST-EFFORT AND RECORDING IS NOT. An inbound message from a
 * number nobody recognises is still recorded, with every id null. The office
 * can see it, answer it, and attach it to whoever it turns out to be. Dropping
 * it because the sender is unknown would mean a new customer texting the
 * business number disappears.
 */
create or replace function record_inbound_message(
  p_provider_id  text,
  p_from_address text,
  p_to_address   text,
  p_body         text,
  p_channel      message_channel default 'sms'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_key text := normalize_phone(p_from_address);
  v_profile_id uuid;
  v_cleaner_id uuid;
  v_customer_id uuid;
  v_lead_id uuid;
begin
  -- Who is this? Each lookup is independent, because one number can legitimately
  -- be all of them: a cleaner who is also a customer, a lead who became one.
  select id into v_profile_id from profiles
   where normalize_phone(phone) = v_key and v_key is not null limit 1;

  select id into v_cleaner_id from cleaners
   where profile_id = v_profile_id and v_profile_id is not null limit 1;

  select id into v_customer_id from customers
   where normalize_phone(phone) = v_key and v_key is not null
   order by created_at desc limit 1;

  -- Only an open lead. A lead closed six months ago is not who is texting now.
  select id into v_lead_id from leads
   where normalize_phone(phone) = v_key and v_key is not null
     and status in ('new', 'quoted')
   order by received_at desc limit 1;

  insert into messages (
    channel, direction, provider_id, from_address, to_address, body,
    from_profile_id, cleaner_id, customer_id, lead_id
  ) values (
    p_channel, 'inbound', p_provider_id, p_from_address, p_to_address, p_body,
    v_profile_id, v_cleaner_id, v_customer_id, v_lead_id
  )
  -- The predicate has to be repeated: the index is partial, and an
  -- unqualified ON CONFLICT cannot infer a partial one.
  on conflict (provider_id) where provider_id is not null
  do nothing
  returning id into v_id;

  return v_id;
end $$;

/**
 * STOP, applied to the NUMBER rather than to a role.
 *
 * The person who texts STOP is telling us to stop texting that handset. They
 * are not telling us which of our tables they appear in, and it is not their
 * job to know that the same number is on a cleaner's profile and a customer
 * record from two years ago. Honouring it in one place and not the other is
 * both a carrier violation and, in the cleaner's case, a quiet penalty: offers
 * she cannot see, expiring against her acceptance rate.
 *
 * Idempotent, and reversible by START, which is the other half carriers
 * require.
 */
create or replace function set_sms_opt_out_by_phone(
  p_phone     text,
  p_opted_out boolean,
  p_reason    text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_key text := normalize_phone(p_phone);
  v_touched integer := 0;
  v_count integer;
begin
  if v_key is null then return 0; end if;

  update profiles set
    sms_opted_out_at = case when p_opted_out then coalesce(sms_opted_out_at, now()) else null end,
    sms_opted_out_reason = case when p_opted_out then p_reason else null end
  where normalize_phone(phone) = v_key;
  get diagnostics v_count = row_count; v_touched := v_touched + v_count;

  update customers set
    sms_opted_out_at = case when p_opted_out then coalesce(sms_opted_out_at, now()) else null end,
    sms_opted_out_reason = case when p_opted_out then p_reason else null end
  where normalize_phone(phone) = v_key;
  get diagnostics v_count = row_count; v_touched := v_touched + v_count;

  return v_touched;
end $$;

/** Mark a thread read. The inbox's only write, and deliberately not per-message. */
create or replace function mark_thread_read(
  p_customer_id uuid default null,
  p_cleaner_id  uuid default null,
  p_lead_id     uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update messages set read_at = now()
   where direction = 'inbound' and read_at is null
     and ( (p_customer_id is not null and customer_id = p_customer_id)
        or (p_cleaner_id  is not null and cleaner_id  = p_cleaner_id)
        or (p_lead_id     is not null and lead_id     = p_lead_id) );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- --------------------------------------------------------- automations -----
/**
 * The queue that makes anything happen on a schedule.
 *
 * `automations` has existed since 0001 and has never had a row written to it.
 * What it needs to actually run is what every other sweep in this system has
 * needed: an identity so it cannot be scheduled twice, a lease so two sweeps
 * cannot fire it at once, and a record of what happened that outlives the
 * process that did it.
 *
 * WHY A LEASE AND NOT `fired_at is null` AS THE GUARD. The window between
 * reading a due row and sending the text is a network call to Twilio. Two
 * sweeps overlapping — a scheduled one and a hand-run one, or a retry after a
 * timeout — both read the row as unfired, and the customer gets two identical
 * reminders. The message-level dedupe key catches most of that, but not the
 * case where the first attempt has not yet reached `record_message`. The lease
 * closes it at the source, and it expires, so a process that dies holding one
 * does not strand the reminder for ever.
 */
alter table automations
  add column dedupe_key text,
  add column lease_owner uuid,
  add column lease_expires_at timestamptz,
  add column attempts integer not null default 0,
  -- What the action produced, where that is a row worth pointing at: the
  -- message that was sent, so "did the reminder go out" has one answer.
  add column message_id uuid references messages(id) on delete set null;

alter table automations
  add constraint automations_lease_has_owner
    check ((lease_owner is null) = (lease_expires_at is null));

create unique index automations_dedupe on automations (dedupe_key)
  where dedupe_key is not null;

-- The sweep's working set: due, not yet fired. Everything else is history.
create index automations_due on automations (scheduled_for)
  where fired_at is null;

-- Stuck: claimed, lease long gone, still not fired. A person's problem.
create index automations_stuck on automations (lease_expires_at)
  where fired_at is null and lease_owner is not null;

create or replace function automation_lease_seconds() returns integer
language sql immutable as $$ select 120 $$;

/**
 * Schedule an action, once.
 *
 * Returns the automation id, or NULL when one with this key already exists.
 * Callers build the key from the subject and the trigger, exactly as they do
 * for messages: `job:<uuid>:reminder.day_before`.
 *
 * Scheduling is separate from firing on purpose. The thing that KNOWS a
 * reminder is due — a job being booked, a clean being completed — is a request
 * handler with a user waiting on it, and it has no business making a network
 * call to Twilio before it can answer. It writes a row and returns.
 */
create or replace function schedule_automation(
  p_dedupe_key   text,
  p_trigger_key  text,
  p_action_key   text,
  p_subject_type text,
  p_subject_id   uuid,
  p_scheduled_for timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into automations (
    dedupe_key, trigger_key, action_key, subject_type, subject_id, scheduled_for
  ) values (
    p_dedupe_key, p_trigger_key, p_action_key, p_subject_type, p_subject_id, p_scheduled_for
  )
  on conflict (dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_id;

  return v_id;
end $$;

/**
 * Move an action that has not fired yet.
 *
 * A visit gets rescheduled. The reminder scheduled for the night before the OLD
 * date is now wrong, and because its key is the job it cannot simply be
 * scheduled again — `schedule_automation` would return null and the customer
 * would be reminded about a Tuesday that moved to Thursday.
 *
 * Only unfired, unleased rows move. A reminder already sent stays sent: the
 * history of what the platform said is not editable, and a row being fired is
 * exactly what makes the planner schedule a fresh one under a new key.
 */
create or replace function reschedule_automation(
  p_dedupe_key text,
  p_scheduled_for timestamptz
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update automations set scheduled_for = p_scheduled_for
   where dedupe_key = p_dedupe_key
     and fired_at is null
     and lease_owner is null
     and scheduled_for is distinct from p_scheduled_for;

  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

/**
 * Take a batch of due work, exclusively.
 *
 * SKIP LOCKED rather than a plain FOR UPDATE: two sweeps running at once should
 * divide the queue between them, not queue up behind each other. A sweep that
 * blocks on another sweep's row is a sweep that spends its whole runtime
 * waiting to do nothing.
 *
 * `clock_timestamp()` rather than `now()` because `now()` is the transaction's
 * start and never advances within it — a lease compared against it can never be
 * seen to expire from inside a long-running statement. A lease is wall time.
 */
create or replace function claim_due_automations(
  p_owner uuid,
  p_limit integer default 50,
  p_now   timestamptz default null
) returns setof automations
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_seconds integer := automation_lease_seconds();
begin
  return query
  with due as (
    select id from automations
     where fired_at is null
       and scheduled_for is not null
       and scheduled_for <= v_now
       and (lease_expires_at is null or lease_expires_at < clock_timestamp())
     order by scheduled_for
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update automations a set
    lease_owner = p_owner,
    lease_expires_at = clock_timestamp() + make_interval(secs => v_seconds),
    attempts = a.attempts + 1
  from due
  where a.id = due.id
  returning a.*;
end $$;

/**
 * What the action did.
 *
 * Scoped to the lease owner, like every other finish in this codebase: a slow
 * handler waking up after its lease expired must not overwrite the result of
 * the handler that took over from it.
 *
 * An outcome of 'failed' releases the lease rather than marking it fired, so
 * the next sweep picks it up. `attempts` is what stops that being for ever —
 * the sweep gives up on a row that has tried too many times and leaves it for
 * a person, which is the same shape as auto-charge giving up after four.
 */
create or replace function settle_automation(
  p_id      uuid,
  p_owner   uuid,
  p_outcome text,
  p_error   text default null,
  p_message_id uuid default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update automations set
    fired_at = case when p_outcome = 'failed' then null else now() end,
    outcome = p_outcome,
    error = p_error,
    message_id = coalesce(p_message_id, message_id),
    lease_owner = null,
    lease_expires_at = null
  where id = p_id and lease_owner = p_owner;

  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ------------------------------------------------------------- ratings ----
/**
 * Record what the customer said, from a link in a text message.
 *
 * WHY THIS IS NOT A LOGGED-IN ACTION. The review request is an SMS with a link,
 * and a customer who has to sign in to answer "how was it" does not answer it.
 * The rate of response to a one-tap link versus a login wall is the difference
 * between having a rating on a cleaner and not having one — and the rating is
 * not a vanity number here, it is an input to the eligibility gate. A cleaner
 * nobody rates is a cleaner the 3.9 floor cannot judge.
 *
 * WHAT STANDS IN FOR AUTHENTICATION. The job id: 122 bits of random, sent only
 * to the number on the customer record, usable only while the job is complete,
 * and good for exactly one rating per customer because of the unique index that
 * has been on this table since 0001. That is the same bargain every review link
 * in the industry makes, and it is written down here rather than assumed.
 *
 * The score is clamped by a CHECK on the table rather than trusted from the
 * request. A rating of 11 is not a compliment, it is somebody editing a URL.
 */
create or replace function record_rating(
  p_job_id  uuid,
  p_score   numeric,
  p_comment text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer_id uuid;
  v_cleaner_id  uuid;
  v_status      job_status;
  v_id          uuid;
begin
  select j.customer_id, j.status into v_customer_id, v_status
    from jobs j where j.id = p_job_id;

  if v_customer_id is null then return null; end if;

  -- Only a finished clean can be rated. Rating one that has not happened is
  -- either a mistake or somebody probing, and neither should reach the gate.
  if v_status <> 'complete' then return null; end if;

  -- Whoever actually did it. Without an assignment there is nobody to rate,
  -- and a rating attached to no cleaner teaches the gate nothing.
  select ja.cleaner_id into v_cleaner_id
    from job_assignments ja
   where ja.job_id = p_job_id
   order by ja.is_lead desc, ja.assigned_at
   limit 1;

  if v_cleaner_id is null then return null; end if;

  insert into ratings (job_id, cleaner_id, customer_id, score, comment)
  values (p_job_id, v_cleaner_id, v_customer_id, greatest(1, least(5, p_score)), p_comment)
  on conflict (job_id, customer_id) do update
    -- A customer changing their mind is a customer changing their mind. The
    -- last thing they said is what they think.
    set score = excluded.score, comment = excluded.comment
  returning id into v_id;

  /**
   * Recompute the cleaner's standing.
   *
   * Denormalised onto `cleaners` because the eligibility gate is a CHECK on the
   * offers table and a CHECK cannot run an aggregate — the floor has to be a
   * column it can read. Recomputed here rather than by a nightly job so that a
   * cleaner who drops below 3.9 stops being offered work with the next sweep,
   * not the next morning.
   */
  update cleaners c
     set rating = sub.avg_score
    from (select avg(score) as avg_score from ratings where cleaner_id = v_cleaner_id) sub
   where c.id = v_cleaner_id;

  return v_id;
end $$;

revoke all on function record_rating(uuid, numeric, text) from public, anon, authenticated;
grant execute on function record_rating(uuid, numeric, text) to service_role;

/**
 * What the rating page may show before anyone has rated: enough to prove the
 * link is real ("your clean on Tuesday with Marisol"), and nothing else. No
 * address, no price, no customer name — the link travels by SMS and SMS gets
 * forwarded.
 */
create or replace function rateable_job(p_job_id uuid)
returns table (job_id uuid, completed_at timestamptz, cleaner_first_name text, already_rated boolean)
language sql security definer set search_path = public as $$
  select j.id,
         j.completed_at,
         split_part(c.full_name, ' ', 1),
         exists (select 1 from ratings r where r.job_id = j.id)
    from jobs j
    left join job_assignments ja on ja.job_id = j.id
    left join cleaners c on c.id = ja.cleaner_id
   where j.id = p_job_id and j.status = 'complete'
   order by ja.is_lead desc nulls last
   limit 1
$$;

revoke all on function rateable_job(uuid) from public, anon, authenticated;
grant execute on function rateable_job(uuid) to service_role;

-- ------------------------------------------------------- row level security
/**
 * A customer reads their own thread, in both directions.
 *
 * 0003's `messages_own` already allows it for select, and that is the whole
 * permission: a customer may READ their thread. They may not write a row —
 * an inbound message is written by the webhook under service-role, and letting
 * a browser session insert one would let a customer forge a message from
 * anybody whose number they know.
 *
 * So nothing is added here for customers or cleaners. What IS added is the
 * grant list below: nobody but an admin and the service role touches the
 * automation queue, because it is machinery rather than a record anyone has a
 * claim on.
 */

revoke all on function record_message(text, text, message_channel, text, text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function record_inbound_message(text, text, text, text, message_channel)
  from public, anon, authenticated;
revoke all on function set_sms_opt_out_by_phone(text, boolean, text) from public, anon, authenticated;
revoke all on function schedule_automation(text, text, text, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function reschedule_automation(text, timestamptz) from public, anon, authenticated;
revoke all on function claim_due_automations(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function settle_automation(uuid, uuid, text, text, uuid) from public, anon, authenticated;

grant execute on function record_message(text, text, message_channel, text, text, uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function record_inbound_message(text, text, text, text, message_channel)
  to service_role;
grant execute on function set_sms_opt_out_by_phone(text, boolean, text) to service_role;
grant execute on function schedule_automation(text, text, text, text, uuid, timestamptz) to service_role;
grant execute on function reschedule_automation(text, timestamptz) to service_role;
grant execute on function claim_due_automations(uuid, integer, timestamptz) to service_role;
grant execute on function settle_automation(uuid, uuid, text, text, uuid) to service_role;

-- The office replies from the inbox as itself, under RLS, so this one is for
-- authenticated admins too. It writes nothing but a timestamp.
grant execute on function mark_thread_read(uuid, uuid, uuid) to service_role, authenticated;
grant execute on function normalize_phone(text) to service_role, authenticated;
