import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AutomationStore, type JobContact, type LeadContact } from "@/lib/automations/store";
import {
  ACTION_BOOKING_CONFIRMED,
  ACTION_REVIEW_REQUEST,
  ACTION_VISIT_REMINDER,
  NUDGE_HOURS,
  nudgeStep,
  planForJob,
  planForLead,
} from "@/lib/automations/plan";
import {
  BOOKING_CONFIRMED,
  LEAD_NUDGE,
  MessagingStore,
  REVIEW_REQUEST,
  VISIT_REMINDER,
} from "@/lib/messaging/store";
import {
  bookingConfirmedMessage,
  leadNudgeMessage,
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

  // Leads within the reach of the nudge sequence. Bounded by the last rung
  // rather than by "all open leads": past 72 hours the sequence is finished,
  // and a planner that rescans the whole history every hour gets slower every
  // month the business runs.
  const leads = await store.leadsToPlan(
    new Date(now.getTime() - (NUDGE_HOURS[2] + 1) * 3_600_000),
  );

  const planned = [
    ...jobs.flatMap((job) => planForJob(job, now)),
    ...leads.flatMap((lead) => planForLead(lead, now)),
  ];

  for (const action of planned) {
    try {
      const outcome = await store.schedule(action);
      if (outcome === "scheduled") result.planned += 1;
      if (outcome === "moved") result.moved += 1;
    } catch (error) {
      // One unplannable subject must not cost the rest their messages.
      result.failed += 1;
      problems.push({ id: action.dedupeKey, error: messageOf(error) });
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

  const [contacts, leadContacts] = await Promise.all([
    store.contactsFor(due.filter((d) => d.subjectType === "job").map((d) => d.subjectId)),
    store.leadContactsFor(due.filter((d) => d.subjectType === "lead").map((d) => d.subjectId)),
  ]);

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

      const outcome =
        automation.subjectType === "lead"
          ? await fireLead(automation.actionKey, leadContacts.get(automation.subjectId), messaging)
          : await fire(automation.actionKey, contacts.get(automation.subjectId), {
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

/**
 * Chase a lead, or decide not to.
 *
 * EVERY CONDITION IS RE-CHECKED HERE, not trusted from when the nudge was
 * planned. Between the planner and this moment — up to three days — the lead
 * may have been answered by a person, booked, marked spam, or replied STOP.
 * Each of those is a different reason to stop, and sending anyway is the
 * failure everybody has received from somebody else's CRM: a chasing text about
 * something you already bought.
 *
 * The status check does most of the work, and `set_lead_status` cancels the
 * queue outright when a lead is won or lost. This is the belt to that braces:
 * a status changed by a direct SQL update, or by something written later that
 * forgets to cancel, still cannot produce a text.
 */
async function fireLead(
  actionKey: string,
  lead: LeadContact | undefined,
  messaging: MessagingStore,
): Promise<FireOutcome> {
  if (!lead) return { kind: "skipped", reason: "lead no longer exists" };

  const step = nudgeStep(actionKey);
  if (!step) return { kind: "skipped", reason: `nothing to send for ${actionKey}` };

  if (lead.status !== "new" && lead.status !== "quoted") {
    return { kind: "skipped", reason: `lead is ${lead.status}` };
  }
  // A person got there first, which is the outcome the sequence exists to make
  // unnecessary. Nothing more is owed.
  if (lead.firstResponseAt) return { kind: "skipped", reason: "already answered by a person" };
  if (!lead.smsConsentAt) return { kind: "skipped", reason: "no SMS consent on file" };
  if (!lead.phone) return { kind: "skipped", reason: "no phone on file" };
  if (!isMessagingEnabled()) return { kind: "skipped", reason: "messaging is disabled" };

  const body = leadNudgeMessage({
    firstName: lead.firstName,
    quotedCents: lead.quotedPriceCents,
    step,
  });

  const messageId = await messaging.claimByKey({
    dedupeKey: `lead:${lead.leadId}:${actionKey}`,
    kind: LEAD_NUDGE,
    body,
    to: lead.phone,
    leadId: lead.leadId,
  });
  if (!messageId) return { kind: "skipped", reason: "already sent" };

  const sent = await sendSms(lead.phone, body);
  if (!sent.ok) {
    await messaging.settle(messageId, null, sent.reason);
    return { kind: "failed", reason: sent.reason };
  }

  await messaging.settle(messageId, sent.providerId);
  return { kind: "sent", messageId };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "automation failed";
}
