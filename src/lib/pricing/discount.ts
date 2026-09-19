import { buildQuote, type ExtraSelection, type RoomCounts } from "./quote";
import { frequenciesForService, type Frequency, type ServiceType } from "./price-book";

/**
 * What committing to a schedule saves, in money, said out loud.
 *
 * WHY DERIVE IT RATHER THAN STORE IT. The price book holds a rate per
 * (item, frequency) — a fortnightly bedroom simply costs less than a one-time
 * one. There is no "discount" column anywhere, and adding one would be a second
 * place for the truth to live and drift from.
 *
 * But a fortnightly customer is worth several times a one-time one, and a
 * number that arrives as "$170" tells nobody they are already being looked
 * after. "$219, or $170 when it repeats — you save $49" is the same two prices
 * with the decision made visible. That is the whole reason this exists: the
 * saving is real, it is already in the book, and nothing was showing it.
 *
 * Pure, and derived from the same `buildQuote` the office and the recurring
 * generator use, so the saving can never disagree with the price.
 */

export interface FrequencySaving {
  /** What this clean would cost as a one-off. */
  oneTimeCents: number;
  /** What it costs at the chosen frequency. */
  frequencyCents: number;
  /** The difference, always positive — see `frequencySaving`. */
  savingCents: number;
  /** As a fraction of the one-time price, for "save up to 20%". */
  savingFraction: number;
}

/**
 * The saving against the one-time rate, or null when there is not one to show.
 *
 * Null rather than a zero saving in three cases, and each is a case where a
 * "discount" would be a lie:
 *
 *   * The customer chose one-time. There is nothing to compare against.
 *   * The service is not sold one-time, so there is no baseline.
 *   * The recurring rate is not actually cheaper. That should not happen with
 *     the current book, and if it ever does, showing a NEGATIVE saving as a
 *     discount is worse than showing nothing.
 */
export function frequencySaving(
  service: ServiceType,
  frequency: Frequency,
  rooms: RoomCounts,
  extras: readonly ExtraSelection[] = [],
): FrequencySaving | null {
  if (frequency === "one_time") return null;
  if (!frequenciesForService(service).includes("one_time")) return null;

  let oneTimeCents: number;
  let frequencyCents: number;
  try {
    oneTimeCents = buildQuote(service, "one_time", rooms, extras).totalCents;
    frequencyCents = buildQuote(service, frequency, rooms, extras).totalCents;
  } catch {
    // An unsellable pair. The quote itself will have said so; this is not the
    // place to raise it a second time.
    return null;
  }

  const savingCents = oneTimeCents - frequencyCents;
  if (savingCents <= 0 || oneTimeCents <= 0) return null;

  return {
    oneTimeCents,
    frequencyCents,
    savingCents,
    savingFraction: savingCents / oneTimeCents,
  };
}

/**
 * The best saving available for a service, for the "Save up to 20%" badge that
 * sits above the frequency picker before anything is chosen.
 *
 * Computed from the same room counts the customer has already entered, so the
 * badge is about THEIR house rather than a marketing figure that may not apply
 * to it.
 */
export function bestFrequencySaving(
  service: ServiceType,
  rooms: RoomCounts,
  extras: readonly ExtraSelection[] = [],
): FrequencySaving | null {
  const savings = frequenciesForService(service)
    .map((frequency) => frequencySaving(service, frequency, rooms, extras))
    .filter((s): s is FrequencySaving => s !== null);

  if (savings.length === 0) return null;

  return savings.reduce((best, s) => (s.savingCents > best.savingCents ? s : best));
}
