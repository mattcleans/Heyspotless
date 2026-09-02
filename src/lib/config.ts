/**
 * Business constants. Real operating data, not demo fixtures — these belong to
 * the domain and are used identically in demo and production.
 */

import type { GeoPoint } from "./dispatch/route";

/**
 * The average ticket, from the build plan. Used to express a cleaner's weekly
 * cost as a share of revenue on the dispatch board.
 */
export const AVERAGE_TICKET_CENTS = 17000;

/**
 * ZIP centroids for the DFW service area. Good enough to cluster a day's route
 * and rank candidates by proximity; a routing API replaces this when drive
 * estimates need to be exact rather than comparative.
 */
export const ZIP_CENTROIDS: Readonly<Record<string, GeoPoint>> = {
  "75024": { latitude: 33.0751, longitude: -96.8236 }, // Plano
  "75034": { latitude: 33.1507, longitude: -96.8236 }, // Frisco
  "75002": { latitude: 33.1032, longitude: -96.6706 }, // Allen
  "75080": { latitude: 32.9754, longitude: -96.7297 }, // Richardson
  "75069": { latitude: 33.1976, longitude: -96.6153 }, // McKinney
  "75201": { latitude: 32.7876, longitude: -96.7994 }, // Dallas
  "76102": { latitude: 32.7555, longitude: -97.3308 }, // Fort Worth
};
