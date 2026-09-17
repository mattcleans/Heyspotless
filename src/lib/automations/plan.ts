import { BUSINESS_TIME_ZONE, addCalendarDays, todayIn, zonedTimeToUtc } from "../time/zone";

/**
 * What should have been scheduled, worked out from the schedule itself.
 *
 * WHY THE PLANNER DERIVES RATHER THAN BEING TOLD. The obvious design is that
 * whatever books a job also writes its reminder — a hook on the write path. It
 * is also the design that quietly loses messages, for reasons that are all
 * boring and all real: a visit created by the recurring generator at 2am, a
 * visit moved by an admin from a form that does not know about reminders, a
 * visit imported from Housecall Pro, a reminder whose write failed while the
 * booking's succeeded. Every one of those is a customer who was promised a
 * reminder by the system's own description of itself and did not get one.
 *
 * So nothing is hooked. The sweep looks at the next fortnight of work and asks
 * what messages that schedule implies, and the queue is keyed so that asking
 * twice produces one row. A visit that moves has its unfired reminder moved
 * with it, because the plan is recomputed rather than remembered.
 *
 * Pure, and asserted without a database like the rest of the scheduling code.
 */

export const TRIGGER_BOOKED = "job.booked";
export const TRIGGER_REMINDER = "job.reminder";
export const TRIGGER_COMPLETED = "job.completed";

export const ACTION_BOOKING_CONFIRMED = "sms.booking_confirmed";
export const ACTION_VISIT_REMINDER = "sms.visit_reminder";
export const ACTION_REVIEW_REQUEST = "sms.review_request";

/**
 * The hour, in business-local time, at which the evening-before reminder goes
 * out. A policy number: late enough that people are home, early enough that it
 * is not an intrusion, and inside the send window either way.
 */
export const REMINDER_HOUR = 18;

/**
 * How long after a clean to ask how it went.
 *
 * Not on completion. The answer to "how was it" while the cleaner is still
 * putting things in the van is a different answer from the one given after an
 * evening in the house — and it is the second one that should decide whether
 * she is sent back.
 */
export const REVIEW_DELAY_HOURS = 3;

/**
 * How recently a job must have been created for a booking confirmation to be
 * planned for it.
 *
 * THIS IS A BLAST GUARD, NOT A TIMING PREFERENCE. The planner runs over a
 * fortnight of schedule, and the Housecall Pro migration in phase 09 will
 * insert several hundred existing visits into that window in one transaction.
 * Without this, the next sweep confirms every one of them by text, to real
 * customers, about bookings they made months ago. There is no apology that
 * fixes that, so the rule is: a confirmation belongs to a job somebody has
 * just booked, and every other job is simply not confirmed.
 */
export const CONFIRMATION_WINDOW_HOURS = 6;

export interface PlannableJob {
  id: string;
  status: string;
  createdAt: Date;
  scheduledStart: Date | null;
  completedAt: Date | null;
}

export interface PlannedAutomation {
  dedupeKey: string;
  triggerKey: string;
  actionKey: string;
  subjectType: "job";
  subjectId: string;
  scheduledFor: Date;
}

/** `job:<uuid>:sms.visit_reminder` — the identity the queue is keyed on. */
export function automationKey(subjectType: string, subjectId: string, actionKey: string): string {
  return `${subjectType}:${subjectId}:${actionKey}`;
}

/**
 * Every message this job implies, with the instant each is due.
 *
 * Returns nothing for a job with no date — an unscheduled visit has nothing to
 * remind anybody about — and nothing for a cancelled one.
 */
export function planForJob(
  job: PlannableJob,
  now: Date,
  timeZone: string = BUSINESS_TIME_ZONE,
): PlannedAutomation[] {
  const planned: PlannedAutomation[] = [];
  const plan = (triggerKey: string, actionKey: string, scheduledFor: Date) =>
    planned.push({
      dedupeKey: automationKey("job", job.id, actionKey),
      triggerKey,
      actionKey,
      subjectType: "job",
      subjectId: job.id,
      scheduledFor,
    });

  // `canceled`, one L, as the enum spells it in 0001.
  if (job.status === "canceled") return planned;

  // ---- after the clean -----------------------------------------------------
  // Planned from `completedAt` rather than from the schedule, because a job
  // finished three hours late is a job whose review request is due three hours
  // later. The clean that actually happened is the event.
  if (job.completedAt) {
    plan(
      TRIGGER_COMPLETED,
      ACTION_REVIEW_REQUEST,
      new Date(job.completedAt.getTime() + REVIEW_DELAY_HOURS * 3_600_000),
    );
  }

  const start = job.scheduledStart;
  if (!start || start.getTime() <= now.getTime()) return planned;

  // ---- the confirmation ----------------------------------------------------
  const ageHours = (now.getTime() - job.createdAt.getTime()) / 3_600_000;
  const hoursUntilVisit = (start.getTime() - now.getTime()) / 3_600_000;

  // A visit inside a day needs no confirmation — the reminder is either already
  // out or about to be, and two texts an hour apart about one clean is how a
  // business teaches people to ignore it.
  if (ageHours <= CONFIRMATION_WINDOW_HOURS && hoursUntilVisit > 24) {
    plan(TRIGGER_BOOKED, ACTION_BOOKING_CONFIRMED, now);
  }

  // ---- the evening before --------------------------------------------------
  const reminderAt = eveningBefore(start, timeZone);
  // Already past: a visit booked at 9pm for tomorrow morning. Sending a
  // "tomorrow" reminder at 2am is worse than sending none, and the booking
  // confirmation has already said when it is.
  if (reminderAt && reminderAt.getTime() > now.getTime()) {
    plan(TRIGGER_REMINDER, ACTION_VISIT_REMINDER, reminderAt);
  }

  return planned;
}

/**
 * 6pm business-local on the day before the visit.
 *
 * Calendar arithmetic, not `start - 24h`: those are different instants twice a
 * year, and the one that matters is the one that says "tomorrow" to a person
 * reading it in Dallas. Subtracting a fixed number of hours across a daylight
 * boundary sends the reminder at 5pm or 7pm, which is survivable — but the same
 * arithmetic on an early-morning visit sends it on the wrong DAY, which is not.
 */
export function eveningBefore(start: Date, timeZone: string = BUSINESS_TIME_ZONE): Date | null {
  const visitDay = todayIn(timeZone, start);
  const dayBefore = addCalendarDays(visitDay, -1);

  const parsed = zonedTimeToUtc(
    `${dayBefore}T${String(REMINDER_HOUR).padStart(2, "0")}:00`,
    timeZone,
  );
  if (parsed.ok) return parsed.date;
  // 6pm is not an hour any zone skips, but the type says it could be, and
  // "the first instant that does exist" is the right answer if it ever is.
  return parsed.reason === "nonexistent" ? parsed.skippedTo : null;
}
