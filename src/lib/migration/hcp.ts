import type { Frequency, ServiceType } from "../pricing/price-book";
import { pick } from "./csv.ts";
import { utcToZonedParts, zonedTimeToUtc, type CalendarDate } from "../time/zone.ts";

/**
 * Housecall Pro's idea of a row, turned into this system's.
 *
 * Pure, and tested without a database or a file, because every interesting
 * decision in a migration is a mapping decision and mapping decisions are where
 * imports go wrong silently. A price parsed as 1500 instead of 150000 does not
 * fail — it bills somebody $15.
 *
 * WHAT IS DELIBERATELY NOT HERE. Nothing guesses. Where a row cannot be mapped
 * it produces a `problem` with the raw value in it, and the importer counts it
 * and moves on. An import that invents a frequency for an ambiguous row is an
 * import that quietly re-prices a customer.
 *
 * TWO GENERATIONS OF EXPORT. The first aliases in every `pick` below are the
 * headings of the real export taken on 28 September 2026 (`Job #`,
 * `Address_1 Street Line 1`, `Job amount`…). The ones after them are the
 * guesses this file was first written against, kept so an older or differently
 * configured export still reads.
 */

export interface MappedAddress {
  /** `${hcpCustomerId}:${streetKey(street)}` — the property's import key. */
  hcpAddressId: string;
  /** Street line 1 alone — the part the key is made of. */
  line1: string;
  /** Line 1, and line 2 after a comma when there is one. */
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface MappedCustomer {
  hcpId: string;
  firstName: string;
  lastName: string;
  /** What HCP shows, which is what the jobs export repeats as `Customer name`. */
  displayName: string | null;
  email: string | null;
  /** Every address this customer can be reached at, lower-cased, for linking jobs. */
  emails: string[];
  phone: string | null;
  /** Last ten digits, for linking jobs. */
  mobileDigits: string | null;
  homeDigits: string | null;
  notes: string | null;
  firstContactDate: string | null;
  doNotService: boolean;
  /** An unconverted lead: HCP filled the name in with the phone number. */
  nameLooksLikePhone: boolean;
  /** The primary address — the first one with a street and a ZIP. */
  address: MappedAddress | null;
  /** Every address with a street and a ZIP, primary first. */
  addresses: MappedAddress[];
}

/** Room counts as a House Cleaning description states them. Null is "not stated". */
export interface RoomCounts {
  bedrooms: number | null;
  bathrooms: number | null;
  halfBaths: number | null;
  kitchens: number | null;
  utilityRooms: number | null;
  livingRooms: number | null;
}

export interface MappedJob {
  hcpId: string;
  /** Present in older exports only. The 2026 export has no customer id at all. */
  hcpCustomerId: string | null;
  /** What the jobs export says about its customer, for linking without an id. */
  customerRef: {
    email: string | null;
    mobileDigits: string | null;
    name: string | null;
  };
  service: ServiceType;
  /** True when no word in the description matched and `standard` was assumed. */
  serviceDefaulted: boolean;
  serviceRaw: string | null;
  frequency: Frequency;
  /** HCP's own recurring flag. The only thing a plan is ever inferred from. */
  recurring: boolean;
  priceCents: number;
  status: "scheduled" | "complete" | "canceled";
  statusRaw: string | null;
  /** An exact instant, ISO. */
  scheduledStart: string | null;
  /** The Dallas calendar day of `scheduledStart`. */
  scheduledDate: CalendarDate | null;
  completedAt: string | null;
  notes: string | null;
  /** Where the job says it was. Street without a ZIP is kept, and reported. */
  address: { line1: string; street: string; city: string; state: string; zip: string | null } | null;
  rooms: RoomCounts | null;
}

export type Mapped<T> =
  | { ok: true; value: T }
  | { ok: false; problem: string; reason: string; raw?: string };

function fail(reason: string, detail?: string, raw?: string): { ok: false; problem: string; reason: string; raw?: string } {
  return {
    ok: false,
    problem: detail ? `${detail}: ${reason}` : reason,
    reason,
    ...(raw === undefined ? {} : { raw }),
  };
}

/**
 * Money, from whatever the export wrote.
 *
 * `$1,250.00`, `1250.00`, `1250`, `(1,250.00)` for a credit. The failure worth
 * engineering against is the silent one: `parseFloat("$1,250.00")` is NaN, and
 * a NaN that becomes 0 is a job imported at no charge.
 */
export function parseMoneyCents(raw: string | null): number | null {
  if (!raw) return null;

  const negative = /^\(.*\)$/.test(raw.trim());
  const cleaned = raw.replace(/[()$,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;

  // Rounded rather than truncated: 0.1 + 0.2 arithmetic on a CSV of prices
  // otherwise loses a cent per row, and those cents end up in an invoice.
  const cents = Math.round(dollars * 100);
  return negative ? -cents : cents;
}

export interface ExportDate {
  /** The Dallas calendar day. */
  date: string;
  /** The Dallas wall-clock time, or null for a bare date. */
  time: string | null;
  /** Present only when the export stated its own offset: the exact instant. */
  instant?: string;
}

const OFFSET_ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A date, as the export writes it.
 *
 * TWO KINDS OF VALUE, and they are resolved differently on purpose:
 *
 *   - `2022-03-24T10:00:00-05:00` says which instant it is. It is taken at its
 *     word — the offset, not the business calendar, decides the instant — and
 *     the Dallas day and time are read off that instant. Treating it as a
 *     Dallas wall clock happens to give the same answer for an export made in
 *     Dallas, and a different one the day HCP writes UTC instead.
 *   - `9/17/2026 10:00 AM` and `2026-09-17 10:00` do not. They are wall-clock
 *     times in Dallas, and `resolveInstant` sends them through the business
 *     calendar — the same path every other date in this system takes, with the
 *     same answer for the hour the clocks skip.
 *
 * A bare date with no time is returned as a calendar date, because midnight is
 * not what was meant.
 */
export function parseExportDate(raw: string | null): ExportDate | null {
  if (!raw) return null;

  const trimmed = raw.trim();

  const offset = OFFSET_ISO.exec(trimmed);
  if (offset) {
    const ms = Date.parse(trimmed.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isFinite(ms)) return null;
    const instant = new Date(ms);
    const p = utcToZonedParts(instant);
    return {
      date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
      time: `${pad(p.hour)}:${pad(p.minute)}`,
      instant: instant.toISOString(),
    };
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(trimmed);
  if (iso) {
    return {
      date: `${iso[1]}-${iso[2]}-${iso[3]}`,
      time: iso[4] && iso[5] ? `${iso[4]}:${iso[5]}` : null,
    };
  }

  // US format, which is what the dashboard exports: 9/17/2026 10:00 AM
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/.exec(trimmed);
  if (!us) return null;

  const [, m, d, y, hh, mm, meridiem] = us;
  const month = String(Number(m)).padStart(2, "0");
  const day = String(Number(d)).padStart(2, "0");

  let time: string | null = null;
  if (hh && mm) {
    let hour = Number(hh);
    // 12am is 00 and 12pm is 12 — the two the naive version gets backwards.
    if (meridiem && /p/i.test(meridiem) && hour !== 12) hour += 12;
    if (meridiem && /a/i.test(meridiem) && hour === 12) hour = 0;
    time = `${String(hour).padStart(2, "0")}:${mm}`;
  }

  return { date: `${y}-${month}-${day}`, time };
}

/**
 * The instant an export date names.
 *
 * An offset in the export wins. Otherwise the value is a Dallas wall clock —
 * 09:00 when no time was given — resolved through the business calendar. A
 * time in the hour the clocks skip lands on the moment they skipped to, which
 * is what this importer has always done with it.
 */
export function resolveInstant(value: ExportDate | null): string | null {
  if (!value) return null;
  if (value.instant) return value.instant;
  const parsed = zonedTimeToUtc(`${value.date}T${value.time ?? "09:00"}`);
  if (parsed.ok) return parsed.date.toISOString();
  return parsed.reason === "nonexistent" ? parsed.skippedTo.toISOString() : null;
}

const SERVICE_WORDS: [RegExp, ServiceType][] = [
  [/move[\s-]?(in|out)/i, "move_in_out"],
  [/deep/i, "deep"],
  [
    /standard|regular|recurring|maintenance|general|house\s*clean|arrival|air\s*bnb|turnover|custom\s*quote/i,
    "standard",
  ],
];

/**
 * Which of the three services this was.
 *
 * Matched on the line item's name, because that is all an export gives. The
 * order matters: "Deep Clean - Move Out" is a move-out, and checking for "deep"
 * first would price it as the cheaper service.
 *
 * The 2026 export's own words — "House Cleaning, 3 x Bedrooms…", "Arrival",
 * "AirBnB Turnover Clean", "Custom Quote" — are all the standard clean, priced
 * as quoted. The job keeps the price it was charged either way; what this
 * decides is which column of the book a re-quote reads.
 */
export function mapService(raw: string | null): ServiceType | null {
  if (!raw) return null;
  for (const [pattern, service] of SERVICE_WORDS) {
    if (pattern.test(raw)) return service;
  }
  return null;
}

const FREQUENCY_WORDS: [RegExp, Frequency][] = [
  [/every\s*(other|2)\s*week|bi[\s-]?weekly|fortnight/i, "biweekly"],
  [/month/i, "monthly"],
  [/week/i, "weekly"],
  [/one[\s-]?time|single|once/i, "one_time"],
];

/**
 * How often.
 *
 * THE ORDER IS THE WHOLE FUNCTION. "Every other week" contains "week", and
 * reading it as weekly doubles that customer's visits and halves the price of
 * each. Biweekly is therefore tested first, and monthly before weekly for the
 * same reason.
 *
 * Null rather than a default. A plan imported at the wrong frequency is a
 * customer billed the wrong amount every fortnight for ever, and "we assumed
 * one-time" is not a defence.
 */
export function mapFrequency(raw: string | null): Frequency | null {
  if (!raw) return null;
  for (const [pattern, frequency] of FREQUENCY_WORDS) {
    if (pattern.test(raw)) return frequency;
  }
  return null;
}

/**
 * What state the job is in.
 *
 * Anything not recognisably finished or cancelled is treated as scheduled, and
 * that asymmetry is deliberate: a scheduled job that turns out to be finished
 * is a row somebody corrects, while a finished job imported as scheduled would
 * put a clean that already happened onto the dispatch board.
 */
export function mapJobStatus(raw: string | null): "scheduled" | "complete" | "canceled" {
  if (!raw) return "scheduled";
  if (/complete|finished|done|closed|paid/i.test(raw)) return "complete";
  if (/cancel|void|declin/i.test(raw)) return "canceled";
  return "scheduled";
}

/** `true`/`yes`/`1`, as a boolean. Anything else is false. */
export function parseFlag(raw: string | null): boolean {
  return raw !== null && /^(true|yes|y|1)$/i.test(raw.trim());
}

/** The last ten digits of a phone number, which is how two spellings of one number compare. */
export function phoneDigits(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** HCP fills an unconverted lead's name with the number it came from. */
export function looksLikePhone(raw: string | null): boolean {
  if (!raw) return false;
  return /^[\d\s()+.\-]+$/.test(raw.trim()) && raw.replace(/\D/g, "").length >= 10;
}

/**
 * The part of a street that makes it a key. Unchanged from the first importer
 * so an `hcp_address_id` written by it is still the same id.
 */
export function streetKey(street: string): string {
  return street.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Looser than `streetKey`, for deciding whether a job's street is one of its
 * customer's: `123 Main St.` on the job and `123 Main St` on the customer are
 * one house. Never used as a key, only to find one.
 */
export function streetMatchKey(street: string): string {
  return streetKey(street).replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}

/** ZIP+4 is the same five-digit ZIP; service zones are five digits. */
export function normaliseZip(raw: string): string {
  const zip = /^(\d{5})(?:-?\d{4})?$/.exec(raw.trim());
  return zip ? zip[1]! : raw.trim();
}

function mapAddress(
  hcpId: string,
  line1: string | null,
  line2: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
): MappedAddress | null {
  if (!line1 || !zip) return null;
  return {
    // No address id in the export: the street plus the customer is stable
    // enough to re-run against, and is what a human would use. Line 2 is kept
    // on the street for the cleaner and out of the key, because the jobs export
    // does not always repeat it.
    hcpAddressId: `${hcpId}:${streetKey(line1)}`,
    line1,
    street: line2 ? `${line1}, ${line2}` : line1,
    city: city ?? "",
    state: state ?? "TX",
    zip: normaliseZip(zip),
  };
}

export function mapCustomer(row: Record<string, string>): Mapped<MappedCustomer> {
  const hcpId = pick(row, "id", "customer_id", "client_id");
  if (!hcpId) return fail("no customer id");

  const first = pick(row, "first_name", "customer_first_name", "firstname");
  const last = pick(row, "last_name", "customer_last_name", "lastname");
  const company = pick(row, "company", "company_name", "name", "customer_name");
  const displayName = pick(row, "display_name");

  // A cleaning business has customers who are companies — an agency managing a
  // rental. The company name is the name, and dropping it because the first
  // name column is empty loses the customer entirely.
  const firstName = first ?? company ?? displayName;
  if (!firstName) return fail("no name", `customer ${hcpId}`);

  // Five address blocks in the 2026 export; one flat set of columns in older
  // ones. Every block with a street and a ZIP becomes a property.
  const addresses: MappedAddress[] = [];
  for (let n = 1; n <= 5; n++) {
    const address = mapAddress(
      hcpId,
      pick(row, `address_${n}_street_line_1`),
      pick(row, `address_${n}_street_line_2`),
      pick(row, `address_${n}_city`),
      pick(row, `address_${n}_state`),
      pick(row, `address_${n}_postal_code`),
    );
    if (address && !addresses.some((a) => a.hcpAddressId === address.hcpAddressId)) {
      addresses.push(address);
    }
  }
  if (addresses.length === 0) {
    const legacy = mapAddress(
      hcpId,
      pick(row, "street", "address", "address_line_1", "service_address", "street_1"),
      null,
      pick(row, "city", "service_city"),
      pick(row, "state", "service_state"),
      pick(row, "zip", "zip_code", "postal_code"),
    );
    if (legacy) addresses.push(legacy);
  }

  const email = pick(row, "email", "customer_email");
  const emails = [email, ...(pick(row, "additional_emails") ?? "").split(/[,;\s]+/)]
    .map((e) => e?.trim().toLowerCase() ?? "")
    .filter((e, i, all) => e.includes("@") && all.indexOf(e) === i);

  const doNotService = parseFlag(pick(row, "do_not_service"));
  // `customers` has no column for it, and adding one is a decision for another
  // day. In the notes it is at least in front of whoever books them.
  const notes = [pick(row, "notes", "customer_notes", "description"), doNotService ? "[HCP] Do not service" : null]
    .filter(Boolean)
    .join("\n");

  return {
    ok: true,
    value: {
      hcpId,
      firstName,
      lastName: last ?? "",
      displayName: displayName ?? ([first, last].filter(Boolean).join(" ") || null),
      email,
      emails,
      phone: pick(
        row,
        "mobile_number",
        "phone",
        "phone_number",
        "customer_phone",
        "home_number",
        "work_number",
      ),
      mobileDigits: phoneDigits(pick(row, "mobile_number", "phone", "phone_number", "customer_phone")),
      homeDigits: phoneDigits(pick(row, "home_number")),
      notes: notes || null,
      firstContactDate:
        parseExportDate(pick(row, "customer_created_at", "created_at", "date_created", "customer_since"))
          ?.date ?? null,
      doNotService,
      nameLooksLikePhone: looksLikePhone(firstName) || looksLikePhone(displayName),
      address: addresses[0] ?? null,
      addresses,
    },
  };
}

const ROOM_PATTERNS: [keyof RoomCounts, RegExp][] = [
  ["bedrooms", /(\d+)\s*x\s*bedrooms?\b/i],
  ["bathrooms", /(\d+)\s*x\s*full\s*baths?\b/i],
  ["halfBaths", /(\d+)\s*x\s*half\s*baths?\b/i],
  ["kitchens", /(\d+)\s*x\s*kitchens?\b/i],
  ["utilityRooms", /(\d+)\s*x\s*utility\s*rooms?\b/i],
  ["livingRooms", /(\d+)\s*x\s*living\s*rooms?\b/i],
];

/**
 * Room counts from a House Cleaning description:
 * `House Cleaning, 3 x Bedrooms, 2 x Full Baths, 0 x Half Baths, 1 x Kitchen, …`.
 *
 * A count the description does not state is null, not zero — zero bedrooms is
 * a studio, and a studio is priced.
 */
export function parseRoomCounts(raw: string | null): RoomCounts | null {
  if (!raw) return null;
  const counts: RoomCounts = {
    bedrooms: null,
    bathrooms: null,
    halfBaths: null,
    kitchens: null,
    utilityRooms: null,
    livingRooms: null,
  };
  let found = false;
  for (const [key, pattern] of ROOM_PATTERNS) {
    const match = pattern.exec(raw);
    if (match) {
      counts[key] = Number(match[1]);
      found = true;
    }
  }
  return found ? counts : null;
}

export function mapJob(row: Record<string, string>): Mapped<MappedJob> {
  const hcpId = pick(row, "job", "job_id", "invoice_number", "id");
  if (!hcpId) return fail("no job id");

  const hcpCustomerId = pick(row, "customer_id", "client_id");
  const customerRef = {
    email: pick(row, "customer_email")?.toLowerCase() ?? null,
    mobileDigits: phoneDigits(pick(row, "customer_mobile_number")),
    name: pick(row, "customer_name"),
  };
  if (!hcpCustomerId && !customerRef.email && !customerRef.mobileDigits && !customerRef.name) {
    return fail("no customer reference", `job ${hcpId}`);
  }

  const serviceRaw = pick(row, "job_description", "line_items", "service", "job_type", "description", "name");
  const mappedService = mapService(serviceRaw);

  const frequencyRaw = pick(row, "recurrence", "frequency", "schedule", "job_type", "line_items");
  // A one-off job is the honest default for a JOB (a plan is different, and
  // `mapFrequency` returning null there is fatal on purpose) — what it changes
  // is which column of the price book a re-quote would read, not what the
  // customer is charged, because the price comes across as it was. A job that
  // belongs to an imported plan takes the plan's frequency later.
  const frequency = mapFrequency(frequencyRaw) ?? "one_time";

  const priceRaw = pick(row, "job_amount", "total", "amount", "invoice_total", "price", "job_total");
  const priceCents = parseMoneyCents(priceRaw);
  if (priceCents === null) return fail("no readable price", `job ${hcpId}`, priceRaw ?? "");

  // `job_status` before `state`: the 2026 export has a `State` column, and it
  // is the address's.
  const statusRaw = pick(row, "job_status", "status", "state");
  const status = mapJobStatus(statusRaw);
  const scheduled = parseExportDate(
    pick(row, "job_scheduled_start_date", "scheduled_start", "start_date", "scheduled_date", "date"),
  );
  const completed = parseExportDate(pick(row, "job_completed_date", "completed_at", "completed_date", "end_date"));

  const street = pick(row, "street");
  const street2 = pick(row, "street_2");
  const zip = pick(row, "zipcode", "zip", "zip_code", "postal_code");

  return {
    ok: true,
    value: {
      hcpId,
      hcpCustomerId,
      customerRef,
      service: mappedService ?? "standard",
      serviceDefaulted: mappedService === null,
      serviceRaw,
      frequency,
      recurring: parseFlag(pick(row, "recurring")),
      priceCents,
      status,
      statusRaw,
      scheduledStart: resolveInstant(scheduled),
      scheduledDate: (scheduled?.date as CalendarDate | undefined) ?? null,
      // Only a job that says it finished gets a completion time. Inferring one
      // from a past date would make every old scheduled job an incumbency.
      completedAt: status === "complete" ? resolveInstant(completed ?? scheduled) : null,
      notes: pick(row, "notes", "job_notes", "description"),
      address: street
        ? {
            line1: street,
            street: street2 ? `${street}, ${street2}` : street,
            city: pick(row, "city") ?? "",
            state: pick(row, "state") ?? "TX",
            zip: zip ? normaliseZip(zip) : null,
          }
        : null,
      rooms: parseRoomCounts(serviceRaw),
    },
  };
}
