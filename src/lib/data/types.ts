/**
 * Domain types returned by the repository.
 *
 * These are deliberately NOT generated database types. Generated types describe
 * table shape; these describe what the app means — money already in cents,
 * dates already parsed, room counts gathered into one object the price book can
 * consume. Mapping happens once, at the boundary, in mappers.ts.
 */

import type { Frequency, ServiceType } from "../pricing/price-book";
import type { Cleaner, DispatchJob } from "../dispatch/types";
import type { RoomCounts } from "../pricing/quote";
import type { InvoiceAmounts, InvoiceStatus, PaymentStatus } from "../billing/types";
import type { CalendarDate } from "../time/zone";

export type UserRole = "admin" | "cleaner" | "customer";

export interface Profile {
  id: string;
  role: UserRole;
  fullName: string;
  email: string | null;
  phone: string | null;
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /**
   * What the office needs to know before quoting or scheduling — the dog that
   * bites, the neighbour with the key, the reason they left the last cleaner.
   *
   * Carried on the domain type rather than fetched separately because the edit
   * form writes every field it has: a notes field the form could not see was a
   * notes field the form silently blanked on the next save.
   */
  notes: string | null;
  lifetimeValueCents: number;
  /** Null until their first Stripe interaction creates the customer object. */
  stripeCustomerId: string | null;
  /**
   * Autopay consent, both halves. `autopayEnabled` without
   * `autopayAuthorizedAt` is rejected by a CHECK constraint in 0006 — the
   * timestamp is the evidence, and a card on file is not consent to use it.
   */
  autopayEnabled: boolean;
  autopayAuthorizedAt: Date | null;
  /**
   * Set when the SYSTEM turned autopay off, and why — today that means the
   * last saved card was removed, which withdraws consent with it (0013).
   *
   * Null when the customer turned it off themselves. It exists so the screen
   * can say "we switched this off because…" rather than a bare "Off" the
   * customer has to work out for themselves.
   */
  autopayEndedAt: Date | null;
  autopayEndedReason: string | null;
}

export interface Property {
  id: string;
  customerId: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  rooms: RoomCounts;
  gateCode: string | null;
  accessNotes: string | null;
  parkingNotes: string | null;
  pets: string | null;
}

/**
 * A job with everything dispatch and the UI need, in one shape. Extends
 * DispatchJob so it can be handed straight to the engine.
 */
export interface Job extends DispatchJob {
  customerId: string;
  customerName: string;
  propertyId: string;
  street: string;
  city: string;
  service: ServiceType;
  frequency: Frequency;
  bedrooms: number;
  bathrooms: number;
  status: string;
}

export type { Cleaner };

/**
 * An invoice as the app means it. `amounts` is the shape lib/billing/amounts.ts
 * operates on, so an invoice can be handed straight to the money rules;
 * `balanceCents` is read back from the generated column rather than recomputed,
 * so the row and the UI can never disagree about what is owed.
 */
export interface Invoice {
  id: string;
  customerId: string;
  jobId: string | null;
  status: InvoiceStatus;
  amounts: InvoiceAmounts;
  balanceCents: number;
  /**
   * A calendar DAY, not an instant. "Due on the 15th" has no time of day, and
   * the moment it is turned into one the answer to "is this overdue" starts
   * depending on the server's zone — an invoice due today falls overdue at 7pm
   * the evening before, in a UTC process. Compared against `todayIn()`.
   */
  dueOn: CalendarDate | null;
  issuedAt: Date | null;
  voidedAt: Date | null;
  /** Auto-charge state. Zero attempts means it has never been tried. */
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  status: PaymentStatus;
  method: string | null;
  isAutocharge: boolean;
  failureMessage: string | null;
  succeededAt: Date | null;
  createdAt: Date;
}

/**
 * A saved card, as metadata only. The card itself never leaves Stripe — this
 * is what the customer sees on their account page, and nothing here is card
 * data under PCI.
 */
export interface PaymentMethod {
  id: string;
  customerId: string;
  stripePaymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface InvoiceFilter {
  customerId?: string;
  /** Only invoices with something still owed. */
  outstanding?: boolean;
  limit?: number;
}

export interface JobFilter {
  /** Jobs with no cleaner assigned yet — the dispatch board's default view. */
  needingCleaner?: boolean;
  cleanerId?: string;
  customerId?: string;
  limit?: number;
}

/**
 * A live offer, as the cleaner's screen needs it.
 *
 * Deliberately carries no rung index, no ceiling, and nothing that hints the
 * payout might improve — the same rule `presentOffer` follows in the dispatch
 * ladder, for the same reason: a visible ascending ladder teaches every
 * rational cleaner to decline the opening rate and wait.
 *
 * `isExclusive` is not that. It says the job is being held for her because
 * this is her customer, which is information she is entitled to and which is
 * the whole reason the hold exists.
 */
export interface Offer {
  id: string;
  jobId: string;
  cleanerId: string;
  payoutCents: number;
  estimatedMinutes: number;
  expiresAt: Date;
  isExclusive: boolean;
  /** Enough of the job to decide on it. */
  customerName: string;
  street: string;
  city: string;
  zip: string;
  scheduledStart: Date | null;
}
