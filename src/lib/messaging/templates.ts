/**
 * What the platform actually says.
 *
 * Pure string building, kept away from the send path so the wording can be
 * asserted without a Twilio account — and so changing a message is a change to
 * one file rather than an archaeology exercise.
 *
 * Customer-facing SMS, when it is added, takes its name from CUSTOMER_BRAND
 * in ../brand. That is this app's copy — the Webflow site is separate.
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

import { CUSTOMER_BRAND } from "../brand";
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

// ============================================================================
// CUSTOMER-FACING MESSAGES (phase 06)
//
// A different audience with different rules from the cleaner messages above.
//
//   1. THEY SAY WHO IS TEXTING. A cleaner recognises the number because she
//      works here. A customer gets a text from an unfamiliar Dallas number
//      about their house, and the first question is who this is. So every one
//      of these names the brand.
//   2. THEY ARE NOT NEGOTIATIONS. Nothing here has a countdown, a price that
//      moves, or anything to accept. A reminder is a courtesy.
//   3. THEY CARRY THE OPT-OUT. A2P registration requires it on recurring
//      traffic, and these are the recurring traffic. The one exception is the
//      on-my-way text: the cleaner is fifteen minutes from the door, the
//      message exists so nobody is startled, and there is no version of this
//      business where the answer to it is "unsubscribe".
// ============================================================================

/** Sent once, when a visit is put on the calendar. */
export function bookingConfirmedMessage(input: {
  customerFirstName: string;
  service: string;
  street: string;
  scheduledStart: Date;
}): string {
  return [
    `${input.customerFirstName} — you're booked with ${CUSTOMER_BRAND}.`,
    `${input.service} · ${input.street}`,
    formatDateTimeInZone(input.scheduledStart),
    `Reply to this message if anything needs to change.`,
    OPT_OUT,
  ].join("\n");
}

/**
 * The evening before.
 *
 * Names the cleaner when there is one. A customer who knows Marisol is coming
 * opens the door to Marisol; a customer expecting "a cleaner" opens it to a
 * stranger. It is also the cheapest churn intervention the business has — the
 * visit nobody remembered is the visit that gets cancelled at the door and
 * still costs a cleaner her afternoon.
 */
export function visitReminderMessage(input: {
  customerFirstName: string;
  cleanerFirstName: string | null;
  street: string;
  scheduledStart: Date;
}): string {
  const who = input.cleanerFirstName
    ? `${input.cleanerFirstName} will be there`
    : `your cleaner will be there`;

  return [
    `${input.customerFirstName} — a reminder from ${CUSTOMER_BRAND}: ${who} tomorrow.`,
    `${formatDateTimeInZone(input.scheduledStart)} · ${input.street}`,
    `Reply here to reschedule.`,
    OPT_OUT,
  ].join("\n");
}

/**
 * Sent by the cleaner, from her phone, on her way.
 *
 * No opt-out line, and no brand preamble either — see the header. This one is
 * as close to a person texting a person as the platform gets.
 */
export function onMyWayMessage(input: {
  customerFirstName: string;
  cleanerFirstName: string;
  minutesAway: number | null;
}): string {
  const eta =
    input.minutesAway && input.minutesAway > 0
      ? `about ${input.minutesAway} minutes away`
      : `on the way now`;

  return `${input.customerFirstName} — ${input.cleanerFirstName} from ${CUSTOMER_BRAND} is ${eta}.`;
}

/**
 * After the clean.
 *
 * The rating is not a vanity metric: it is an input to the eligibility gate, so
 * a cleaner nobody rates is a cleaner the gate cannot judge. Sent a few hours
 * later rather than on completion, because the answer to "how was it" while
 * somebody is still standing in the kitchen is not the answer they would give
 * having lived in the house for an evening.
 */
export function reviewRequestMessage(input: {
  customerFirstName: string;
  cleanerFirstName: string | null;
  ratingUrl: string;
}): string {
  const who = input.cleanerFirstName ? `${input.cleanerFirstName}'s` : "today's";

  return [
    `${input.customerFirstName} — how was ${who} clean?`,
    `One tap: ${input.ratingUrl}`,
    `It decides who we send back.`,
    OPT_OUT,
  ].join("\n");
}

// ============================================================================
// LEAD MESSAGES (phase 07)
//
// The only messages in this system sent to somebody who is not yet a customer,
// and the rules shift again:
//
//   1. THEY ANSWER THE QUESTION THAT WAS ASKED. Somebody who just typed their
//      room counts into a form wants a number, so the number is in the first
//      line. "Thanks for your enquiry, a member of our team will be in touch"
//      is the message every competitor sends and it says nothing.
//   2. THEY NEVER PRETEND TO BE A PERSON. The acknowledgement goes out in
//      milliseconds; writing it as though somebody typed it is a lie the
//      timestamp gives away, and being caught faking the first message of a
//      relationship is worse than being slow.
//   3. THEY STOP. The nudge sequence is three messages over three days and then
//      silence, whatever happens. A lead that does not answer is not a lead.
// ============================================================================

/** Sent inline the moment the form is submitted. Speed is the whole product. */
export function leadAckMessage(input: {
  firstName: string;
  quotedCents: number | null;
}): string {
  const price = input.quotedCents
    ? `Your estimate is ${formatCents(input.quotedCents)}.`
    : `We have your details.`;

  return [
    `${input.firstName} — ${CUSTOMER_BRAND} here. ${price}`,
    `That is from the room counts you gave us; somebody will confirm it against your home and book you in shortly.`,
    `Reply to this message any time.`,
    OPT_OUT,
  ].join("\n");
}

/**
 * The chase.
 *
 * Three, spread over three days, each one different — a sequence that sends the
 * same sentence three times is one people learn to ignore after the first. The
 * last one says it is the last one, because a door closing politely gets more
 * replies than a fourth "just checking in", and because it is true.
 */
export function leadNudgeMessage(input: {
  firstName: string;
  quotedCents: number | null;
  step: 1 | 2 | 3;
}): string {
  const price = input.quotedCents ? formatCents(input.quotedCents) : "your estimate";

  const line =
    input.step === 1
      ? `Still happy to get you booked in at ${price} — what day suits?`
      : input.step === 2
        ? `Anything you want to check before booking? Happy to answer questions, and the ${price} holds.`
        : `Last one from us — if the timing is wrong, no problem at all. Reply any time and we will pick it back up.`;

  return [`${input.firstName} — ${CUSTOMER_BRAND}.`, line, OPT_OUT].join("\n");
}
