/**
 * Display formatting. The counterpart to the normalisers in data/validate.ts:
 * those turn what someone typed into what is stored, these turn what is stored
 * back into something readable.
 */

/**
 * Ten stored digits as (972) 555-0134.
 *
 * Anything else is returned unchanged rather than mangled — a number that
 * predates normalisation, or one imported from Housecall Pro, is better shown
 * as-is than reformatted into something wrong.
 */
export function formatPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 10) return phone;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** "3 bd · 2 ba", with half baths folded in the way a listing writes them. */
export function formatRooms(bedrooms: number, bathrooms: number, halfBaths = 0): string {
  const baths = halfBaths > 0 ? `${bathrooms}.5` : String(bathrooms);
  return `${bedrooms} bd · ${baths} ba`;
}
