import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AutomationStore, type JobContact } from "@/lib/automations/store";
import {
  ACTION_BOOKING_CONFIRMED,
  ACTION_REVIEW_REQUEST,
  ACTION_VISIT_REMINDER,
  planForJob,
} from "@/lib/automations/plan";
import {
  BOOKING_CONFIRMED,
  MessagingStore,
  REVIEW_REQUEST,
  VISIT_REMINDER,
} from "@/lib/messaging/store";
import {
  bookingConfirmedMessage,
  reviewRequestMessage,
  visitReminderMessage,
} from "@/lib/messaging/templates";
import { isQuietHour } from "@/lib/messaging/quiet-hours";
import { sendSms } from "@/lib/messaging/gateway";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { cronSecretMatches } from "@/lib/stripe/env";

/**
 * The automation sweep: everything the business says on a schedule.
 *
 * Two passes, in this order.
 *
 * PLAN. Look at the next fortnight of work and write down what messages that
 * schedule implies. Nothing hooks the booking path to do this, deliberately —
 * see `lib/automations/plan.ts`. The planner derives, which means a visit
 * created by the recurring generator at 2am, moved by an admin from a form that
 * has never heard of reminders, or imported from Housecall Pro all get the same
 * treatment as one booked by hand this morning.
 *
 * FIRE. Take the due rows under a lease and send them. The lease is what stops
 * two sweeps — the scheduled one and one somebody kicked by hand — texting a
 * customer twice about the same Tuesday.
 *
 * Guarded by CRON_SECRET like the other sweeps, and idempotent like them: every
 * message is claimed under a key built from what it is about, so the worst a
 * double run costs is a wasted database round trip.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How far ahead the planner looks. Longer than the reminder needs, so a visit is queued well before its evening. */
const PLANNING_HORIZON_DAYS = 14;

/** How far back to look for completed cleans that have not been asked about. */
const LOOKBACK_DAYS = 2;

const BATCH = 50;

/**
 * When to stop trying.
 *
 * A send that fails for a reason that will not change — an unreachable number,
 * a body the carrier rejects — fails identically every hour for ever, and the
 * queue silts up behind it. Four is the same number auto-charge gives up after,
 * for the same reason: past that it is a person's problem, not a retry's.
 */
const MAX_ATTEMPTS = 4;

export async function POST(request: NextRequest) {
  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (!cronSecretMatches(presented)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const store = new AutomationStore(db);
  const messaging = new MessagingStore(db);
  const now = new Date();

  // One owner per sweep. Two sweeps running at once divide the queue between
  // them rather than fighting over it, and a lease identifies which of them
  // holds what.
  const owner = randomUUID();

  const result = {
    planned: 0,
    moved: 0,
    due: 0,
    sent: 0,
    skipped: 0,
    deferred: 0,
    abandoned: 0,
    failed: 0,
  };
  const problems: { id: string; error: string }[] = [];

  // ---- plan ----------------------------------------------------------------
  const jobs = await store.jobsToPlan(
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
    new Date(now.getTime() + PLANNING_HORIZON_DAYS * 86_400_000),
  );

  for (const job of jobs) {
    for (const planned of planForJob(job, now)) {
      try {
        const outcome = await store.schedule(planned);
        if (outcome === "scheduled") result.planned += 1;
        if (outcome === "moved") result.moved += 1;
      } catch (error) {
        // One unplannable job must not cost the rest their reminders.
        result.failed += 1;
        problems.push({ id: planned.dedupeKey, error: messageOf(error) });
      }
    }
  }

  /**
   * NOTHING IS SENT AT NIGHT.
   *
   * Every action this queue currently holds is a text to a customer, and none
   * of them is urgent enough to justify a 3am phone buzz — a reminder about
   * Tuesday is a courtesy, and a courtesy delivered at 3am is not one. Rows
   * stay due and the first sweep after 08:00 sends them.
   *
   * The cleaner offers keep their own urgent-override path, in quiet-hours.ts,
   * because an unfilled same-day visit genuinely is worth waking somebody for.
   * When this queue grows an action that is not a message — an invoice to
   * raise, a plan to close — this guard has to move down to the message
   * actions rather than gating the whole pass.
   */
  if (isQuietHour(now)) {
    return NextResponse.json({ ...result, quietHours: true });
  }

  // ---- fire ----------------------------------------------------------------
  const due = await store.claimDue(owner, BATCH);
  result.due = due.length;

  const jobIds = due.filter((d) => d.subjectType === "job").map((d) => d.subjectId);
  const contacts = await store.contactsFor(jobIds);

  for (const automation of due) {
    try {
      // Tried too many times. Marked fired with the reason recorded, so it
      // stops rather than failing identically every hour until somebody
      // notices the queue is not moving.
      if (automation.attempts > MAX_ATTEMPTS) {
        await store.settle(automation.id, owner, "skipped", "gave up after repeated failures");
        result.abandoned += 1;
        continue;
      }

      const contact = contacts.get(automation.subjectId);
      const outcome = await fire(automation.actionKey, contact, {
        messaging,
        origin: request.nextUrl.origin,
      });

      switch (outcome.kind) {
        case "sent":
          await store.settle(automation.id, owner, "sent", null, outcome.messageId);
          result.sent += 1;
          break;
        case "skipped":
          await store.settle(automation.id, owner, "skipped", outcome.reason);
          result.skipped += 1;
          break;
        case "failed":
          await store.settle(automation.id, owner, "failed", outcome.reason);
          result.failed += 1;
          problems.push({ id: automation.id, error: outcome.reason });
          break;
      }
    } catch (error) {
      result.failed += 1;
      problems.push({ id: automation.id, error: messageOf(error) });
      // The lease expires on its own, so a row that threw here is picked up by
      // a later sweep rather than stranded.
      console.error(`automation ${automation.id} failed`, error);
    }
  }

  return NextResponse.json(problems.length > 0 ? { ...result, problems } : result);
}

type FireOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

interface Deps {
  messaging: MessagingStore;
  origin: string;
}

/**
 * Turn one due row into one text.
 *
 * Every reason not to send is a `skipped` with the reason recorded rather than
 * a silent success. "Why did this customer not get their reminder" is a
 * question the office will ask, and the answer has to be in the row.
 */
async function fire(
  actionKey: string,
  contact: JobContact | undefined,
  deps: Deps,
): Promise<FireOutcome> {
  if (!contact) return { kind: "skipped", reason: "job no longer exists" };
  if (contact.status === "canceled") return { kind: "skipped", reason: "visit canceled" };
  if (contact.customerOptedOut) return { kind: "skipped", reason: "customer opted out" };
  if (!contact.customerPhone) return { kind: "skipped", reason: "no phone on file" };

  const built = build(actionKey, contact, deps.origin);
  if (!built) return { kind: "skipped", reason: `nothing to send for ${actionKey}` };

  // Messaging switched off — a local run, or a demo. The row is marked skipped
  // rather than left due, so a development database does not accumulate a
  // backlog that all fires at once the day somebody sets the Twilio keys.
  if (!isMessagingEnabled()) return { kind: "skipped", reason: "messaging is disabled" };

  const messageId = await deps.messaging.claimByKey({
    dedupeKey: built.dedupeKey,
    kind: built.kind,
    body: built.body,
    to: contact.customerPhone,
    customerId: contact.customerId,
    jobId: contact.jobId,
  });

  // Already recorded. The automation is done even though this sweep sent
  // nothing: the message went out under a previous lease whose settle did not
  // land, and sending it again is the failure the key exists to prevent.
  if (!messageId) return { kind: "skipped", reason: "already sent" };

  const sent = await sendSms(contact.customerPhone, built.body);
  if (!sent.ok) {
    await deps.messaging.settle(messageId, null, sent.reason);
    // Retryable failures come back around; the rest burn an attempt and give
    // up at four, which is what MAX_ATTEMPTS is counting.
    return { kind: "failed", reason: sent.reason };
  }

  await deps.messaging.settle(messageId, sent.providerId);
  return { kind: "sent", messageId };
}

interface BuiltMessage {
  dedupeKey: string;
  kind: string;
  body: string;
}

function build(actionKey: string, contact: JobContact, origin: string): BuiltMessage | null {
  switch (actionKey) {
    case ACTION_BOOKING_CONFIRMED:
      if (!contact.scheduledStart) return null;
      return {
        dedupeKey: `job:${contact.jobId}:${actionKey}`,
        kind: BOOKING_CONFIRMED,
        body: bookingConfirmedMessage({
          customerFirstName: contact.customerFirstName,
          service: contact.service,
          street: contact.street,
          scheduledStart: contact.scheduledStart,
        }),
      };

    case ACTION_VISIT_REMINDER:
      if (!contact.scheduledStart) return null;
      return {
        dedupeKey: `job:${contact.jobId}:${actionKey}`,
        kind: VISIT_REMINDER,
        body: visitReminderMessage({
          customerFirstName: contact.customerFirstName,
          cleanerFirstName: contact.cleanerFirstName,
          street: contact.street,
          scheduledStart: contact.scheduledStart,
        }),
      };

    case ACTION_REVIEW_REQUEST:
      return {
        dedupeKey: `job:${contact.jobId}:${actionKey}`,
        kind: REVIEW_REQUEST,
        body: reviewRequestMessage({
          customerFirstName: contact.customerFirstName,
          cleanerFirstName: contact.cleanerFirstName,
          ratingUrl: `${origin}/rate/${contact.jobId}`,
        }),
      };

    default:
      return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "automation failed";
}
