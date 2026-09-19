import { assertWholeCents } from "./amounts";
import { BillingError } from "./types";

/**
 * A tip belongs to the cleaner.
 *
 * THE RULE, AS THE BUSINESS STATED IT: the only thing that may come out of a
 * tip is the card processing fee on the tip itself. Not a platform share, not
 * the 33% the work is priced at, not a rounding convenience. A customer tipping
 * $20 is tipping the person who cleaned their house, and every cent that does
 * not reach her has to be a cent a payment processor took.
 *
 * WHICH FEE, EXACTLY, AND WHY IT IS ONLY THE PERCENTAGE. A card charge costs
 * 2.9% + 30¢. But the tip does not arrive as its own transaction — it rides on
 * the invoice charge that was happening anyway, and that charge pays the 30¢
 * whether or not a tip is added. So the fee CAUSED by the tip is the percentage
 * alone. Deducting a share of the fixed fee as well would be charging her for
 * something the business was going to pay regardless, which is the skim this
 * rule exists to prevent.
 *
 * ROUNDING GOES TO THE CLEANER. The fee is rounded DOWN to the cent, so where a
 * fraction is in play she keeps it and the business absorbs at most one cent
 * per tip. The alternative — rounding up — means the business deducts very
 * slightly more than the processor actually charged, which is indefensible for
 * a sum this small and this personal.
 */

/**
 * Stripe's standard percentage for a domestic card. A policy number, and the
 * one to change if the rate is ever negotiated — the fixed component is
 * deliberately absent, per the header.
 */
export const CARD_PERCENTAGE_FEE = 0.029;

export interface TipPassThrough {
  /** What the customer added. */
  tipCents: number;
  /** The processing fee caused by the tip, and the only permitted deduction. */
  feeCents: number;
  /** What reaches the cleaner. */
  netCents: number;
}

/**
 * Split a tip into what the processor takes and what the cleaner gets.
 *
 * Whole cents in, whole cents out, and `fee + net === tip` always — a tip that
 * does not reconcile is a tip somebody has to account for by hand.
 */
export function tipPassThrough(
  tipCents: number,
  percentageFee: number = CARD_PERCENTAGE_FEE,
): TipPassThrough {
  assertWholeCents(tipCents, "tip");

  if (tipCents < 0) throw new BillingError("a tip cannot be negative");
  if (percentageFee < 0 || percentageFee >= 1) {
    throw new BillingError(`a processing fee of ${percentageFee} is not a fraction of a charge`);
  }

  // Floor, not round: see the header. The cleaner keeps the fraction.
  const feeCents = Math.floor(tipCents * percentageFee);

  return { tipCents, feeCents, netCents: tipCents - feeCents };
}

/**
 * What to tell the customer, in the one place they will read it.
 *
 * The design said "100% goes to Maria". It is very nearly true and it is not
 * quite true, and a promise about somebody else's money should not be the
 * thing a business rounds. This is the honest version, and it is still a good
 * line: the only deduction is the card fee, and it is named.
 */
export function tipDisclosure(cleanerFirstName: string): string {
  return `Goes to ${cleanerFirstName}, less only the card processing fee.`;
}
