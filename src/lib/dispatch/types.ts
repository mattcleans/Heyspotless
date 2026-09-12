/**
 * Dispatch domain types. Everything in lib/dispatch is pure and deterministic —
 * no database, no clock, no randomness that isn't injected. That is deliberate:
 * this is the money logic, and it has to be testable against the figures in the
 * build plan without standing up infrastructure.
 */

import type { ContinuityContext } from "./continuity";

export type CleanerType = "w2_core" | "contractor_1099";
export type DispatchChannel = "open_board" | "waterfall" | "direct_assign";

/**
 * Employment terms for a W-2 cleaner. Guaranteed hours are the crux: they are
 * paid whether or not they are worked, so a job that fits inside them has a
 * marginal cost of zero and must be spent before any money reaches the market.
 */
export interface W2Terms {
  /** Base wage in cents per hour. */
  hourlyRateCents: number;
  /**
   * Hours paid regardless of work performed. Shonda: 40. A part-timer with no
   * guarantee: null.
   */
  guaranteedHoursPerWeek: number | null;
  /** FLSA overtime threshold — hours past this bill at the multiplier. */
  overtimeThresholdHours: number;
  overtimeMultiplier: number;
  /** FICA, FUTA, Texas SUTA, janitorial workers' comp. Plan assumes 0.15. */
  employerBurdenRate: number;
  /** A company vehicle means no mileage reimbursement — the truck is already paid for. */
  usesCompanyVehicle: boolean;
  /**
   * FLSA: travel between job sites during the workday is compensable for
   * non-exempt employees. Modeled as paid; see the plan's open question.
   */
  driveTimePaid: boolean;
}

export interface Cleaner {
  id: string;
  name: string;
  type: CleanerType;
  status: "applicant" | "onboarding" | "active" | "paused" | "terminated";

  /** Eligibility inputs. */
  rating: number | null;
  acceptanceRate: number | null;
  backgroundCheckCleared: boolean;
  insuranceExpiresOn: Date | null;
  serviceZips: readonly string[];

  /** Present for w2_core, absent for contractors. */
  terms?: W2Terms;

  /** Hours already on this cleaner's schedule this week. Drives the OT split. */
  hoursScheduledThisWeek: number;

  /** Where they finish their previous job — the origin for the drive estimate. */
  lastStopZip?: string;
}

export interface DispatchJob {
  id: string;
  /** Ticket price in cents. */
  priceCents: number;
  /** Estimated cleaning minutes, from the price book. */
  estimatedCleanMinutes: number;
  zip: string;
  scheduledStart: Date | null;
  /** Windows this job could occupy, used by the clustering pass. */
  customerPreferredWindow?: { start: Date; end: Date };
  /**
   * Who already has a relationship with this home.
   *
   * Absent means a genuinely fresh job — a first clean, or a one-off from a
   * customer with no history — and the engine auctions it normally. Present
   * means the incumbent gets first refusal before anyone else sees it. See
   * continuity.ts.
   */
  continuity?: ContinuityContext;
  /**
   * Who has already been asked about this job at what rate, and did not take
   * it — whether she said no or simply never answered.
   *
   * Both have to count. The sweep runs hourly and the engine is stateless, so
   * without this it re-asks the same cleaner the same question every hour for
   * ever; and for an incumbent, an unanswered exclusive hold would renew
   * itself on every sweep and the visit would never reach the open board at
   * all. A hold that cannot lapse is not a hold.
   *
   * The RATE is carried because "do not ask again" is the wrong rule: asking
   * again HIGHER up is legitimate and is the entire mechanism of the ladder.
   * She is not asked again at a rate she has already passed on; a later rung
   * still reaches her. That matters most for the incumbent, because a cleaner
   * who watches a stranger take her own customer at a rate she was never
   * offered learns to stop answering honestly.
   */
  passedOver?: readonly { cleanerId: string; hourlyRateCents: number }[];
  /**
   * The highest hourly rate this job has already been offered at.
   *
   * The ladder is a schedule spread across sweeps, not a broadcast: each run
   * sends one rung. Without this the engine rebuilds the ladder from the
   * opening rate every hour and sends the same rung for ever, so a job nobody
   * wants at $25/h is offered at $25/h until it happens — the escalation the
   * whole ladder exists for never occurs.
   */
  offeredUpToCents?: number;
}

/** A drive leg between two points, estimated or measured. */
export interface DriveLeg {
  minutes: number;
  miles: number;
}
