/**
 * Customer-facing brand vs legal entity, for THIS app (Spotless Ops).
 *
 * The public marketing site (heyspotless.com / Webflow) is a different
 * codebase. This module is for strings this app itself sends or shows:
 * Stripe charge copy, card statements, SMS bodies, customer-portal copy.
 *
 * The name a customer reads is Hey Spotless. The registered company is
 * BLISS CLEANS LLC. Those are not the same string. Collapsing them either
 * markets a name customers no longer book under, or invents an LLC named
 * after the brand that is not the USPTO owner and is not what belongs on
 * a W-9. Never invent a second LLC.
 */

/** What customers, cards, and public copy call the business. */
export const CUSTOMER_BRAND = "Hey Spotless";

/** Registered company. USPTO owner of HEY SPOTLESS. Not a marketing string. */
export const LEGAL_ENTITY = "BLISS CLEANS LLC";

/**
 * Bank-statement / Stripe descriptor. Cards cap this at 22 characters; letters
 * and spaces only. This is what a customer sees on their card, so it is the
 * brand, not the LLC.
 */
export const STATEMENT_DESCRIPTOR = "HEY SPOTLESS";

/** Stripe product / charge text. Brand first; never the legal entity. */
export function invoiceChargeDescription(invoiceId: string): string {
  return `${CUSTOMER_BRAND} — invoice ${invoiceId.slice(0, 8)}`;
}
