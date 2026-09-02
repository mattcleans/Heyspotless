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
  lifetimeValueCents: number;
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

export interface JobFilter {
  /** Jobs with no cleaner assigned yet — the dispatch board's default view. */
  needingCleaner?: boolean;
  cleanerId?: string;
  customerId?: string;
  limit?: number;
}
