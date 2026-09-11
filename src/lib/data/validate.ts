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

import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  frequenciesForService,
  type Frequency,
  type ServiceType,
} from "../pricing/price-book";
import type { RoomCounts } from "../pricing/quote";
import { BUSINESS_TIME_ZONE, zonedTimeToUtc } from "../time/zone";

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

export interface JobInput {
  propertyId: string;
  service: ServiceType;
  frequency: Frequency;
  /** Null books the job onto the board unscheduled, which is a real state. */
  scheduledStart: Date | null;
  notes: string | null;
  /**
   * Start a recurring plan rather than booking a single visit.
   *
   * Only meaningful for a recurring frequency, and only when a start time was
   * given — a plan with no first visit has no cadence to derive. Both are
   * enforced in `parseJob`, so an impossible combination cannot reach the
   * store.
   */
  repeats: boolean;
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

/**
 * A booking.
 *
 * The service/frequency pair is checked against the price book rather than
 * against a list written here: Deep is one-time/monthly only and Move In/Out is
 * one-time only, and `frequenciesForService` is the same function the quote
 * builder uses to populate its dropdown. One source for the rule means the form
 * and the server cannot drift into disagreeing about what is sellable.
 *
 * Note what is NOT here: the price. It is computed server-side from the price
 * book and the property's stored room counts, never accepted from the form.
 */
export function parseJob(fields: Fields): Validated<JobInput> {
  const errors: Record<string, string> = {};

  const propertyId = text(fields, "propertyId");
  if (propertyId === "") errors["propertyId"] = "Choose a property.";

  const serviceRaw = text(fields, "service");
  const service = SERVICE_TYPES.find((s) => s === serviceRaw);
  if (!service) errors["service"] = "Choose a service.";

  const frequencyRaw = text(fields, "frequency");
  const frequency = FREQUENCIES.find((f) => f === frequencyRaw);
  if (!frequency) errors["frequency"] = "Choose a frequency.";

  if (service && frequency && !frequenciesForService(service).includes(frequency)) {
    errors["frequency"] = `${SERVICE_LABELS[service]} is not sold ${FREQUENCY_LABELS[
      frequency
    ].toLowerCase()}.`;
  }

  const scheduledStart = parseWhen(fields, errors);

  const notes = optionalText(fields, "notes");
  if (notes !== null && notes.length > MAX_NOTE) errors["notes"] = "Too long.";

  // A recurring plan derives its whole cadence from the first visit, so it
  // needs one. Asked for without a date, it would be a plan that never
  // happens — which is worse than refusing, because it looks like it worked.
  const repeats = text(fields, "repeats") === "on" || text(fields, "repeats") === "true";
  if (repeats && frequency === "one_time") {
    errors["repeats"] = "A one-time clean does not repeat.";
  }
  if (repeats && scheduledStart === null && !errors["scheduledStart"]) {
    errors["scheduledStart"] = "A repeating plan needs a first date and time.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    // The finds above are what narrow these; the guard is for the type checker.
    value: {
      propertyId,
      service: service as ServiceType,
      frequency: frequency as Frequency,
      scheduledStart,
      notes,
      repeats,
    },
  };
}

/**
 * The scheduled start, from a datetime-local input.
 *
 * A `datetime-local` value carries NO zone — it is the wall clock the operator
 * typed, and nothing more. `new Date(raw)` resolved it against the server's
 * zone, which meant the same booking became a different appointment depending
 * on where the app was deployed and, worse, on whether anyone had thought to
 * set TZ. Bookings are Dallas bookings, so it is resolved in Dallas.
 *
 * Empty is allowed and means unscheduled — a job can sit on the board before it
 * has a slot, which is exactly what the dispatch board is for. A value that is
 * present but unparseable is an error rather than a silent null, because
 * silently unscheduling a job somebody just scheduled is worse than refusing.
 *
 * The hour that does not exist is refused for the same reason: on the morning
 * the clocks go forward there is no 2:30, and quietly booking 1:30 or 3:30
 * instead puts a cleaner at a door an hour away from when anyone agreed.
 */
function parseWhen(fields: Fields, errors: Record<string, string>): Date | null {
  const raw = text(fields, "scheduledStart");
  if (raw === "") return null;

  const parsed = zonedTimeToUtc(raw, BUSINESS_TIME_ZONE);
  if (!parsed.ok) {
    errors["scheduledStart"] =
      parsed.reason === "nonexistent"
        ? "The clocks go forward that morning, so that time does not exist. Pick another."
        : "That is not a valid date and time.";
    return null;
  }
  // An ambiguous time — the repeated hour when the clocks go back — resolves to
  // its first occurrence. It is a real instant either way, so it is booked
  // rather than refused; the alternative is refusing a legitimate 1:30am slot
  // one morning a year.
  return parsed.date;
}
