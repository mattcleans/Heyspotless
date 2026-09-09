/**
 * Parsing and validation for operator-entered data.
 *
 * Pure, in the same spirit as lib/dispatch and lib/billing: the rules about
 * what a valid customer or property looks like are decided here and tested
 * without a database, and the store below only executes. Forms hand this raw
 * strings — everything arrives from an HTML form as text, including the
 * numbers — and get back either a typed value or every problem at once.
 *
 * Every field is collected before returning, rather than throwing on the first
 * failure, because a form that reveals one error per submission is the kind
 * nobody fills in twice.
 */

import type { RoomCounts } from "../pricing/quote";

export type Fields = Record<string, string | undefined>;

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export interface CustomerInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
}

export interface PropertyInput {
  customerId: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  rooms: Required<RoomCounts>;
  gateCode: string | null;
  accessNotes: string | null;
  parkingNotes: string | null;
  pets: string | null;
}

/** Long enough for any real value, short enough to reject a paste of a novel. */
const MAX_TEXT = 200;
const MAX_NOTE = 2000;

/**
 * Ten digits, or eleven starting with a 1. Stored as digits only so that
 * (972) 555-0134 and 972-555-0134 are the same customer when the lead inbox
 * tries to match an inbound text to one.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * Deliberately permissive. The only email worth rejecting at this layer is one
 * that cannot possibly be delivered; anything stricter argues with real
 * addresses and loses.
 */
function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function text(fields: Fields, key: string): string {
  return (fields[key] ?? "").trim();
}

function optionalText(fields: Fields, key: string): string | null {
  const v = text(fields, key);
  return v === "" ? null : v;
}

/**
 * A room count. Absent means "use the default" — a property with no utility
 * room entered has one, per the schema — but a present-and-nonsense value is an
 * error rather than a silent fallback, since quoting multiplies by it.
 */
function roomCount(
  fields: Fields,
  key: string,
  fallback: number,
  errors: Record<string, string>,
): number {
  const raw = text(fields, key);
  if (raw === "") return fallback;

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    errors[key] = "Must be a whole number, 0 or more.";
    return fallback;
  }
  if (n > 50) {
    errors[key] = "That looks like a typo.";
    return fallback;
  }
  return n;
}

export function parseCustomer(fields: Fields): Validated<CustomerInput> {
  const errors: Record<string, string> = {};

  const firstName = text(fields, "firstName");
  const lastName = text(fields, "lastName");
  if (firstName === "") errors["firstName"] = "First name is required.";
  else if (firstName.length > MAX_TEXT) errors["firstName"] = "Too long.";
  if (lastName === "") errors["lastName"] = "Last name is required.";
  else if (lastName.length > MAX_TEXT) errors["lastName"] = "Too long.";

  const emailRaw = optionalText(fields, "email");
  if (emailRaw !== null && !looksLikeEmail(emailRaw)) {
    errors["email"] = "That does not look like an email address.";
  }

  const phoneRaw = optionalText(fields, "phone");
  const phone = phoneRaw === null ? null : normalizePhone(phoneRaw);
  if (phoneRaw !== null && phone === null) {
    errors["phone"] = "Enter a 10-digit US phone number.";
  }

  const notes = optionalText(fields, "notes");
  if (notes !== null && notes.length > MAX_NOTE) errors["notes"] = "Too long.";

  // A customer with no way to reach them is a data-entry slip, not a record.
  if (emailRaw === null && phoneRaw === null) {
    errors["phone"] = "Give at least an email address or a phone number.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { firstName, lastName, email: emailRaw, phone, notes },
  };
}

export function parseProperty(fields: Fields): Validated<PropertyInput> {
  const errors: Record<string, string> = {};

  const customerId = text(fields, "customerId");
  if (customerId === "") errors["customerId"] = "A property must belong to a customer.";

  const street = text(fields, "street");
  const city = text(fields, "city");
  const zip = text(fields, "zip");
  if (street === "") errors["street"] = "Street is required.";
  if (city === "") errors["city"] = "City is required.";
  if (!/^\d{5}$/.test(zip)) errors["zip"] = "Enter a 5-digit ZIP code.";

  const state = text(fields, "state") || "TX";
  if (!/^[A-Za-z]{2}$/.test(state)) errors["state"] = "Use a 2-letter state code.";

  const rooms: Required<RoomCounts> = {
    bedrooms: roomCount(fields, "bedrooms", 0, errors),
    bathrooms: roomCount(fields, "bathrooms", 0, errors),
    halfBaths: roomCount(fields, "halfBaths", 0, errors),
    kitchens: roomCount(fields, "kitchens", 1, errors),
    livingRooms: roomCount(fields, "livingRooms", 1, errors),
    utilityRooms: roomCount(fields, "utilityRooms", 1, errors),
  };

  // Every quote is priced off beds and baths, so a property without them
  // cannot be quoted and should not be saved as though it could.
  if (!errors["bedrooms"] && rooms.bedrooms === 0 && rooms.bathrooms === 0) {
    errors["bedrooms"] = "Enter at least one bedroom or bathroom.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customerId,
      street,
      city,
      state: state.toUpperCase(),
      zip,
      rooms,
      gateCode: optionalText(fields, "gateCode"),
      accessNotes: optionalText(fields, "accessNotes"),
      parkingNotes: optionalText(fields, "parkingNotes"),
      pets: optionalText(fields, "pets"),
    },
  };
}
