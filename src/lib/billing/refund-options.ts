import type { RefundKind, RefundStatus } from "./types";

/**
 * The reasons Management can give for a refund, in the words the office uses.
 *
 * "unattributed" is deliberately absent. It exists for refunds nobody
 * explained (the Stripe dashboard); a person refunding from this app knows
 * why, and the reason decides whether the customer owes the money again.
 * See docs/money-policy.md for the effect of each.
 */
export interface RefundChoice {
  kind: Exclude<RefundKind, "unattributed">;
  label: string;
  effect: string;
}

export const REFUND_CHOICES: readonly RefundChoice[] = [
  {
    kind: "service_refund",
    label: "The clean was the problem",
    effect: "Credited in full. Counts toward service quality.",
  },
  {
    kind: "goodwill",
    label: "Goodwill: the work was fine",
    effect: "Credited in full. Not counted as a service problem.",
  },
  {
    kind: "overpayment",
    label: "They paid more than they owed",
    effect: "Returns the overpaid amount only. The bill stays settled.",
  },
  {
    kind: "correction",
    label: "Charged the wrong way, still owed",
    effect: "The balance becomes due again and can be collected.",
  },
  {
    kind: "dispute",
    label: "The client disputed the charge",
    effect: "The balance is restored and automatic payments are paused.",
  },
];

export function refundChoice(kind: string): RefundChoice | null {
  return REFUND_CHOICES.find((c) => c.kind === kind) ?? null;
}

/** Refunds that have moved money or still might. Failed and canceled ones did not. */
const COUNTED: ReadonlySet<RefundStatus> = new Set(["succeeded", "pending"]);

/** What can still be refunded on one payment, in cents. Never negative. */
export function refundableCents(
  paymentCents: number,
  refunds: readonly { amountCents: number; status: RefundStatus }[],
): number {
  const taken = refunds
    .filter((r) => COUNTED.has(r.status))
    .reduce((sum, r) => sum + r.amountCents, 0);
  return Math.max(0, paymentCents - taken);
}

/**
 * Parse a dollar amount typed into the refund form ("12", "12.5", "$12.50")
 * into cents. Null for anything that is not a positive amount with at most
 * two decimal places.
 */
export function parseRefundDollars(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
