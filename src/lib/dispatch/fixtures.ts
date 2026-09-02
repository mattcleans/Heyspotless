/**
 * The two real W-2 cleaners, with the terms recorded in section 02 of the build
 * plan. Shared by the dispatch tests and the demo-mode fixtures so both are
 * exercising the same terms.
 */

import type { Cleaner, W2Terms } from "./types";

export const SHONDA_TERMS: W2Terms = {
  hourlyRateCents: 1750,
  guaranteedHoursPerWeek: 40,
  overtimeThresholdHours: 40,
  overtimeMultiplier: 1.5,
  employerBurdenRate: 0.15,
  usesCompanyVehicle: true, // company truck, reimbursed nothing
  driveTimePaid: true,
};

export const IGGY_TERMS: W2Terms = {
  hourlyRateCents: 2100,
  guaranteedHoursPerWeek: null, // part-time, no guarantee
  overtimeThresholdHours: 40,
  overtimeMultiplier: 1.5,
  employerBurdenRate: 0.15,
  usesCompanyVehicle: false, // own car, mileage reimbursed at the IRS rate
  driveTimePaid: true,
};

export function shonda(overrides: Partial<Cleaner> = {}): Cleaner {
  return {
    id: "shonda",
    name: "Shonda",
    type: "w2_core",
    status: "active",
    rating: 4.8,
    acceptanceRate: 1,
    backgroundCheckCleared: true,
    insuranceExpiresOn: null,
    serviceZips: [],
    terms: SHONDA_TERMS,
    hoursScheduledThisWeek: 0,
    ...overrides,
  };
}

export function iggy(overrides: Partial<Cleaner> = {}): Cleaner {
  return {
    id: "iggy",
    name: "Iggy",
    type: "w2_core",
    status: "active",
    rating: 4.7,
    acceptanceRate: 1,
    backgroundCheckCleared: true,
    insuranceExpiresOn: null,
    serviceZips: [],
    terms: IGGY_TERMS,
    hoursScheduledThisWeek: 10,
    ...overrides,
  };
}

export function contractor(overrides: Partial<Cleaner> = {}): Cleaner {
  return {
    id: "contractor-1",
    name: "Marketplace Cleaner",
    type: "contractor_1099",
    status: "active",
    rating: 4.4,
    acceptanceRate: 0.7,
    backgroundCheckCleared: true,
    insuranceExpiresOn: null,
    serviceZips: [],
    hoursScheduledThisWeek: 0,
    ...overrides,
  };
}
