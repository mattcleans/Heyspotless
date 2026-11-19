/**
 * Customer-facing brand vs legal entity, for THIS app (Spotless Ops).
 *
 * The public marketing site (heyspotless.com / Webflow) is a different
 * codebase. This module is for strings this app itself sends or shows:
 * Stripe charge copy, card statements, SMS bodies, customer-portal copy.
 *
 * The name a customer reads is "Hey Spotless" — no LLC, because customers
 * book with a brand, not a filing. The registered company is Hey Spotless
 * LLC (confirmed by Matt, 16 November 2026 — this file previously named
 * Bliss Cleans LLC, and anything still registered under that name, such as
 * the Twilio A2P brand, needs updating; see docs/setup.md). The entity
 * string belongs on a W-9 and in underwriting, never in marketing copy.
 */

/** What customers, cards, and public copy call the business. */
export const CUSTOMER_BRAND = "Hey Spotless";

/** Registered company, as it belongs on a W-9. Not a marketing string. */
export const LEGAL_ENTITY = "Hey Spotless LLC";

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
