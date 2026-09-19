/**
 * How a cleaner is shown to a customer.
 *
 * WHAT A CUSTOMER MAY SEE, AND WHY IT IS A SHORT LIST. She is being introduced
 * to somebody who will be alone in their house, so the answer to "who is this"
 * has to be substantial: a face, a name, how long she has done this, what she
 * is good at, what other customers said. And the answer to "where does she
 * live, what is her number, what is she paid" is nothing at all.
 *
 * FIRST NAME AND AN INITIAL. Not the full legal name. A customer needs to
 * recognise her at the door and say her name; they do not need a string they
 * could put into a search engine. This is the same instinct the cleaner
 * messages have about not opening with a full legal name — and here it is
 * about her safety rather than her comfort.
 *
 * Pure, so the rules can be asserted without a database.
 */

/** "Maria Gonzalez" → "Maria G." — what the customer sees everywhere. */
export function displayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "Your cleaner";

  const last = parts[parts.length - 1];
  if (parts.length === 1 || !last) return first;

  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

/** "MG" — the avatar, for before a photo has been uploaded. */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/** Just the first name, for a sentence: "Maria is on her way". */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "Your cleaner";
}

/**
 * "3 yrs", "8 mo", "New".
 *
 * Rounded DOWN, always. A cleaner eleven months in is not "1 yr with us" — the
 * number is a trust signal and inflating it by a month is the kind of small
 * dishonesty that makes every other number on the page worth less.
 */
export function tenureLabel(hiredOn: Date | null, now: Date = new Date()): string {
  if (!hiredOn) return "New";

  const months = completedMonthsBetween(hiredOn, now);
  if (months < 1) return "New";
  if (months < 12) return `${months} mo`;

  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? "" : "s"}`;
}

/**
 * Whole calendar months elapsed, counted the way a person counts them.
 *
 * NOT ELAPSED MILLISECONDS OVER AN AVERAGE MONTH. That is the obvious version
 * and it is wrong at exactly the moment anybody looks: a year is 365 days,
 * an average month is 30.44, and 365/30.44 is 11.99 — so a cleaner on her
 * first anniversary reads "11 mo". Rounding down is the rule; losing a whole
 * year to arithmetic is not rounding down, it is being wrong.
 *
 * Day-of-month decides the final month, so somebody hired on the 30th has not
 * completed a month on the 29th.
 */
function completedMonthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());

  const dayShort = to.getUTCDate() < from.getUTCDate();
  return Math.max(0, months - (dayShort ? 1 : 0));
}

/**
 * The specialties a cleaner can claim.
 *
 * A FIXED LIST RATHER THAN FREE TEXT, because these are filtered on and shown
 * as chips, and forty spellings of "pet friendly" is a filter that matches
 * nothing. The bio is where she says things in her own words.
 */
export const SPECIALTIES = {
  recurring: "Recurring maid service",
  deep: "Deep cleaning",
  move_in_out: "Move in / out",
  pet_friendly: "Pet-friendly",
  eco: "Eco-friendly products",
  organising: "Organising",
  laundry: "Laundry",
} as const;

export type SpecialtyKey = keyof typeof SPECIALTIES;

export function specialtyLabel(key: string): string {
  return SPECIALTIES[key as SpecialtyKey] ?? key;
}

/** "Speaks Spanish" — kept separate from specialties because it is not a skill claim. */
export const LANGUAGES: Record<string, string> = {
  es: "Speaks Spanish",
  en: "Speaks English",
  vi: "Speaks Vietnamese",
};

export function languageLabel(code: string): string {
  return LANGUAGES[code] ?? code;
}

/**
 * How a rating reads when almost nobody has given one yet.
 *
 * `0024` averages ratings against a prior worth five reviews, so a new cleaner
 * shows 4.2 before anybody has rated her at all. Printing that as a rating
 * would be presenting an assumption as a measurement. Under five real ratings
 * the count is shown instead, and the number is not.
 */
export const RATINGS_BEFORE_SHOWING = 5;

export function ratingDisplay(
  rating: number | null,
  ratingCount: number,
): { show: boolean; rating: number | null; label: string } {
  if (ratingCount < RATINGS_BEFORE_SHOWING || rating === null) {
    return {
      show: false,
      rating: null,
      label: ratingCount === 0 ? "New to Hey Spotless" : `${ratingCount} so far`,
    };
  }
  return { show: true, rating, label: `${ratingCount} reviews` };
}
