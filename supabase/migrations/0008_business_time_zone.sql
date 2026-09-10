-- ============================================================================
-- 0008 — the business calendar
--
-- `resettle_invoice` decided overdue with `due_on < current_date`, and
-- `current_date` is whatever the SESSION's TimeZone says. On Supabase that is
-- UTC, so an invoice due today rolled to `overdue` at 00:00 UTC — 7pm the
-- previous evening in Dallas, five hours before the office had even closed,
-- and hours before the customer's own due date had arrived.
--
-- The same mistake had a mirror image in TypeScript (lib/billing/amounts.ts
-- comparing timestamps in the process zone). Both now answer "what day is it
-- where the business is", and lib/time/zone.ts is the TypeScript half.
--
-- A due date is a CALENDAR DAY. It has no time of day, so it must never be
-- compared against an instant — only against today, resolved in one named
-- zone. Scheduled starts are the opposite: genuine instants, stored as
-- timestamptz, and converted at the edges.
-- ============================================================================

/**
 * The zone Hey Spotless operates in.
 *
 * A function rather than a literal sprinkled through the SQL: one place to
 * change if the business ever runs in two, and one thing to grep for. Marked
 * immutable so it may be used in an index predicate later if that is ever
 * needed; the value is a constant, not a setting.
 */
create or replace function business_time_zone() returns text
language sql immutable set search_path = public as $$
  select 'America/Chicago'::text;
$$;

/** Today, where the business is. The only correct basis for "is this overdue". */
create or replace function business_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone business_time_zone())::date;
$$;

/**
 * Bring `status` back in line with the money. Mirrors derivedStatus() in
 * lib/billing/amounts.ts exactly; both are tested against the same cases.
 * A draft or a voided invoice is a decision a person made and is left alone.
 *
 * Unchanged from 0006 except for the date: `current_date` became
 * `business_today()`.
 */
create or replace function resettle_invoice(p_invoice_id uuid)
returns void
language sql security definer set search_path = public as $$
  update invoices set status = case
    when balance_cents <= 0 then 'paid'::invoice_status
    when due_on is not null and due_on < business_today() then 'overdue'::invoice_status
    else 'sent'::invoice_status
  end
  where id = p_invoice_id
    and status not in ('draft', 'void')
    and voided_at is null;
$$;

-- Same posture as 0007: these are server-side routines, not client surface.
revoke all on function business_time_zone() from public, anon, authenticated;
revoke all on function business_today() from public, anon, authenticated;
revoke all on function resettle_invoice(uuid) from public, anon, authenticated;
grant execute on function business_time_zone() to service_role;
grant execute on function business_today() to service_role;
grant execute on function resettle_invoice(uuid) to service_role;
