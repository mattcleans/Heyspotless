/**
 * What the platform actually says.
 *
 * Pure string building, kept away from the send path so the wording can be
 * asserted without a Twilio account — and so changing a message is a change to
 * one file rather than an archaeology exercise.
 *
 * Customer-facing SMS, when it is added, takes its name from CUSTOMER_BRAND
 * in ../brand. The public name is Hey Spotless. Do not market the former
 * name, and do not invent a second LLC named after the brand.
 *
 * Every outbound message to a cleaner obeys three rules:
 *
 *   1. IT NAMES A PRICE, NOT A RATE. The platform pays per clean; saying
 *      "$56.10" is the offer and "$24/hr" is a different business.
 *   2. IT LEAKS NOTHING ABOUT THE LADDER. No rung, no ceiling, no "this may
 *      go up". A cleaner who learns the offer improves if she waits will wait,
 *      which drifts every payout to the ceiling.
 *   3. IT SAYS WHEN IT RUNS OUT. A countdown she cannot see is a countdown she
 *      will lose, and losing one she was never shown is how a good cleaner
 *      quietly stops answering.
 */

import { formatCents } from "../money";
import { formatDateTimeInZone } from "../time/zone";

/** A2P registration requires an opt-out on recurring traffic. */
const OPT_OUT = "Reply STOP to opt out.";

export interface OfferMessageInput {
  cleanerFirstName: string;
  customerName: string;
  street: string;
  city: string;
  payoutCents: number;
  scheduledStart: Date | null;
  expiresAt: Date;
  /** True when this job is being held for her because it is her customer. */
  isExclusive: boolean;
  /** Where she answers it. */
  offerUrl: string;
}

export function offerMessage(input: OfferMessageInput): string {
  const when = input.scheduledStart
    ? formatDateTimeInZone(input.scheduledStart)
    : "date to be confirmed";

  // The exclusive line is the one thing about the dispatch decision that is
  // hers, and it is the reason she should open this rather than ignore it.
  const opening = input.isExclusive
    ? `${input.cleanerFirstName} — your customer ${input.customerName} is booked in.`
    : `${input.cleanerFirstName} — a clean is available.`;

  return [
    opening,
    `${input.street}, ${input.city}`,
    `${when} · ${formatCents(input.payoutCents)}`,
    input.isExclusive
      ? `Held for you until ${formatDateTimeInZone(input.expiresAt)}.`
      : `First to accept takes it. Closes ${formatDateTimeInZone(input.expiresAt)}.`,
    input.offerUrl,
    OPT_OUT,
  ].join("\n");
}

/**
 * Sent when a job she was holding goes to somebody else, or is cancelled.
 *
 * Worth sending rather than leaving her to discover it: a cleaner who plans a
 * Tuesday around a job that quietly vanished has lost the day, and the platform
 * knew and did not say.
 */
export function offerWithdrawnMessage(input: {
  cleanerFirstName: string;
  customerName: string;
  scheduledStart: Date | null;
}): string {
  const when = input.scheduledStart
    ? formatDateTimeInZone(input.scheduledStart)
    : "the unscheduled clean";

  return [
    `${input.cleanerFirstName} — the clean for ${input.customerName} on ${when} is no longer available.`,
    `Nothing needed from you, and it does not count against your acceptance rate.`,
    OPT_OUT,
  ].join("\n");
}

/** Confirmation once she has taken it. Short on purpose. */
export function offerAcceptedMessage(input: {
  cleanerFirstName: string;
  customerName: string;
  street: string;
  scheduledStart: Date | null;
  payoutCents: number;
}): string {
  const when = input.scheduledStart
    ? formatDateTimeInZone(input.scheduledStart)
    : "date to be confirmed";

  return [
    `Booked, ${input.cleanerFirstName}.`,
    `${input.customerName} · ${input.street}`,
    `${when} · ${formatCents(input.payoutCents)}`,
    OPT_OUT,
  ].join("\n");
}
