import type { Frequency, ServiceType } from "../pricing/price-book";
import { pick } from "./csv.ts";

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
 */

export interface MappedCustomer {
  hcpId: string;
  firstName: string;
  lastName: string;
  /** What the jobs export calls this customer. See `CustomerKeys.displayName`. */
  displayName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  firstContactDate: string | null;
  address: MappedAddress | null;
}

/**
 * How a job row points at its customer.
 *
 * THE JOBS EXPORT HAS NO CUSTOMER ID. Housecall Pro's customer export carries
 * an `ID` column; its jobs export does not — it identifies the customer by
 * name, email and phone and nothing else. So the join is on what both files
 * actually share, tried in descending order of how uniquely each identifies a
 * person, and the importer refuses a job it cannot place rather than inventing
 * a customer for it.
 */
export interface CustomerKeys {
  hcpId: string | null;
  /**
   * The customer's display name, which is the jobs export's `Customer name`.
   *
   * MORE SPECIFIC THAN THE EMAIL, for the case this exists to handle: a
   * property manager with one billing address and a customer record per unit.
   * "Bexley Grapevine 3535 Bluffs Ln #14214" and "…#17209" are two customers,
   * two homes and two cleaning histories, sharing one company email — so
   * matching on the email would file half their cleans against the wrong flat.
   */
  displayName: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
}

export interface MappedJob {
  hcpId: string;
  customer: CustomerKeys;
  service: ServiceType;
  frequency: Frequency;
  priceCents: number;
  status: "scheduled" | "complete" | "canceled";
  scheduledStart: string | null;
  completedAt: string | null;
  notes: string | null;
  /**
   * The row stated a cadence the price book cannot sell — "2x a week".
   *
   * The job still imports, at the price it was sold for, so nobody is billed
   * differently. What it flags is that `frequency` below is a fallback rather
   * than a reading, and that this customer needs a decision before anything
   * re-quotes them.
   */
  cadenceUnsupported: boolean;
  /**
   * Where the clean happened, from the JOB row.
   *
   * More than half the customer rows in a real export carry no address at all,
   * while the job rows carry the address the cleaner was actually sent to. That
   * is the better source anyway: it is where the work was done.
   */
  address: MappedAddress | null;
}

export interface MappedAddress {
  hcpAddressId: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export type Mapped<T> = { ok: true; value: T } | { ok: false; problem: string };

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

/**
 * A date, as the export writes it, kept as an ISO instant.
 *
 * NO ZONE IS INVENTED, AND NONE IS DISCARDED. An export's `2026-09-17 10:00`
 * is a wall-clock time in Dallas, and the caller resolves it through the
 * business calendar — the same path every other date in this system takes.
 *
 * But a real Housecall Pro jobs export writes `2024-05-27T21:30:00-05:00`: the
 * offset is right there, which makes the value an absolute instant that needs
 * no interpreting. Throwing it away and re-reading the wall clock as Dallas
 * happens to round-trip while the offset IS Dallas's — and silently shifts
 * every row by an hour the moment a file is exported from anywhere else, or
 * carries a stored UTC time. So the offset is kept when the export states one,
 * and `offset` tells the caller which kind of value it is holding.
 *
 * A bare date with no time is returned as a calendar date, because midnight is
 * not what was meant.
 */
export interface ExportDate {
  date: string;
  time: string | null;
  /** `-05:00`, `Z`, or null when the export stated no offset. */
  offset: string | null;
}

export function parseExportDate(raw: string | null): ExportDate | null {
  if (!raw) return null;

  const trimmed = raw.trim();

  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(
      trimmed,
    );
  if (iso) {
    const rawOffset = iso[6] ?? null;
    return {
      date: `${iso[1]}-${iso[2]}-${iso[3]}`,
      time: iso[4] && iso[5] ? `${iso[4]}:${iso[5]}` : null,
      // Only meaningful alongside a time. `2024-05-27Z` is not a thing.
      offset: iso[4] && rawOffset ? normaliseOffset(rawOffset) : null,
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

  // The dashboard's US format never carries a zone, so this branch is always
  // wall clock and the caller resolves it through the business calendar.
  return { date: `${y}-${month}-${day}`, time, offset: null };
}

/** `-0500` and `-05:00` are the same offset; `Z` is `+00:00`. */
function normaliseOffset(raw: string): string {
  if (raw === "Z") return "+00:00";
  return raw.includes(":") ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
}

/** The ISO string a mapped date becomes: wall clock, or an instant when the export gave one. */
function isoFrom(parsed: ExportDate | null, fallbackTime: string): string | null {
  if (!parsed) return null;
  return `${parsed.date}T${parsed.time ?? fallbackTime}${parsed.time ? (parsed.offset ?? "") : ""}`;
}

const SERVICE_WORDS: [RegExp, ServiceType][] = [
  [/move[\s-]?(in|out)/i, "move_in_out"],
  [/deep/i, "deep"],
  [/standard|regular|recurring|maintenance|general/i, "standard"],
];

/**
 * Which of the three services this was.
 *
 * Matched on the line item's name, because that is all an export gives. The
 * order matters: "Deep Clean - Move Out" is a move-out, and checking for "deep"
 * first would price it as the cheaper service.
 */
export function mapService(raw: string | null): ServiceType | null {
  if (!raw) return null;
  for (const [pattern, service] of SERVICE_WORDS) {
    if (pattern.test(raw)) return service;
  }
  return null;
}

/**
 * A cadence the price book has no column for.
 *
 * Tested BEFORE everything else, because "2x a week" contains "week" and would
 * otherwise read as weekly — which halves that customer's visits and points a
 * re-quote at the wrong rate. The book sells weekly, fortnightly and monthly;
 * twice a week is a real arrangement it cannot express, so it is reported as
 * unmappable rather than rounded to the nearest thing that parses.
 */
const UNSUPPORTED_CADENCE = /(\d+\s*x|twice|thrice|two\s*times|three\s*times)\s*(a|per|\/)?\s*(week|wk)/i;

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
  if (UNSUPPORTED_CADENCE.test(raw)) return null;

  for (const [pattern, frequency] of FREQUENCY_WORDS) {
    if (pattern.test(raw)) return frequency;
  }
  return null;
}

/**
 * True when the row states a cadence the price book cannot sell.
 *
 * Separate from `mapFrequency` returning null, which also covers "no cadence
 * stated at all". This one is "they told us, and we have nowhere to put it" —
 * a customer to decide about, not a blank to ignore.
 */
export function hasUnsupportedCadence(raw: string | null): boolean {
  return raw !== null && UNSUPPORTED_CADENCE.test(raw);
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

export function mapCustomer(row: Record<string, string>): Mapped<MappedCustomer> {
  const hcpId = pick(row, "customer_id", "client_id", "id");
  if (!hcpId) return { ok: false, problem: "no customer id" };

  const first = pick(row, "first_name", "customer_first_name", "firstname");
  const last = pick(row, "last_name", "customer_last_name", "lastname");
  const company = pick(row, "company", "company_name", "name", "customer_name");

  // A cleaning business has customers who are companies — an agency managing a
  // rental. The company name is the name, and dropping it because the first
  // name column is empty loses the customer entirely.
  if (!first && !company) return { ok: false, problem: "no name" };

  // `address_1_*` is what the customer export actually writes — one set of
  // columns per address, numbered, with the first being the service address.
  const street = pick(
    row,
    "address_1_street_line_1",
    "street",
    "address",
    "address_line_1",
    "service_address",
    "street_1",
  );
  const zip = pick(row, "address_1_postal_code", "zip", "zip_code", "postal_code", "zipcode");

  return {
    ok: true,
    value: {
      hcpId,
      firstName: first ?? company ?? "",
      lastName: last ?? "",
      displayName: normaliseName(pick(row, "display_name", "customer_name")),
      email: pick(row, "email", "customer_email"),
      phone: pick(row, "mobile_number", "phone", "phone_number", "customer_phone", "home_number"),
      notes: pick(row, "notes", "customer_notes", "description"),
      firstContactDate: parseExportDate(pick(row, "created_at", "date_created", "customer_since"))?.date ?? null,
      address:
        street && zip
          ? {
              // No address id in most exports: the street plus the customer is
              // stable enough to re-run against, and is what a human would use.
              hcpAddressId: `${hcpId}:${street.toLowerCase().replace(/\s+/g, " ")}`,
              street,
              city: pick(row, "address_1_city", "city", "service_city") ?? "",
              state: pick(row, "address_1_state", "state", "service_state") ?? "TX",
              zip,
            }
          : null,
    },
  };
}

export function mapJob(row: Record<string, string>): Mapped<MappedJob> {
  // `job` is "Job #", the jobs export's own column. It arrives as `="1068"`;
  // `toRecords` has already unwrapped the spreadsheet escaping by here.
  const hcpId = pick(row, "job_id", "job", "invoice_number", "id");
  if (!hcpId) return { ok: false, problem: "no job id" };

  const customer = customerKeys(row);
  if (!customer.hcpId && !customer.email && !customer.phone && !customer.name) {
    return { ok: false, problem: `job ${hcpId}: nothing identifying the customer` };
  }

  const serviceRaw = pick(
    row,
    "line_items",
    "service",
    "job_description",
    "job_type",
    "description",
    "job_name",
    "name",
  );
  const service = mapService(serviceRaw) ?? "standard";

  // `job_tags` is where a real export keeps the cadence: "Biweekly, complete".
  const frequencyRaw = pick(
    row,
    "recurrence",
    "frequency",
    "schedule",
    "job_tags",
    "job_type",
    "line_items",
  );
  // A one-off job is the honest default for a JOB (a plan is different, and
  // `mapFrequency` returning null there is fatal on purpose) — what it changes
  // is which column of the price book a re-quote would read, not what the
  // customer is charged, because the price comes across as it was.
  const frequency = mapFrequency(frequencyRaw) ?? "one_time";

  // `total_service_price` before `job_amount`: the two agree on all but the
  // rows where a job was discounted, and the service price is what the work
  // was sold at.
  const priceCents = parseMoneyCents(
    pick(
      row,
      "total_service_price",
      "total",
      "job_amount",
      "amount",
      "invoice_total",
      "price",
      "job_total",
      "job_revenue",
    ),
  );
  if (priceCents === null) return { ok: false, problem: `job ${hcpId}: no readable price` };

  const status = mapJobStatus(pick(row, "status", "job_status", "state"));
  const scheduled = parseExportDate(
    pick(row, "job_scheduled_start_date", "scheduled_start", "start_date", "scheduled_date", "date"),
  );
  const completed = parseExportDate(
    pick(row, "job_completed_date", "completed_at", "completed_date", "end_date"),
  );

  return {
    ok: true,
    value: {
      hcpId,
      customer,
      service,
      frequency,
      priceCents,
      status,
      scheduledStart: isoFrom(scheduled, "09:00"),
      // Only a job that says it finished gets a completion time. Inferring one
      // from a past date would make every old scheduled job an incumbency.
      completedAt: status === "complete" ? isoFrom(completed ?? scheduled, "09:00") : null,
      notes: pick(row, "notes", "job_notes"),
      cadenceUnsupported: hasUnsupportedCadence(frequencyRaw),
      address: jobAddress(row),
    },
  };
}

/**
 * Everything in a job row that could identify its customer.
 *
 * Normalised here rather than at the comparison, so both sides of the join are
 * reduced by the same rules: a phone is its last ten digits, so `(214) 555-0143`
 * and `+12145550143` are one person, and an email is lower-cased.
 */
export function customerKeys(row: Record<string, string>): CustomerKeys {
  const phone = pick(row, "customer_mobile_number", "customer_home_number", "customer_work_number");
  const name = pick(row, "customer_name", "billed_to", "company");

  return {
    hcpId: pick(row, "customer_id", "client_id"),
    displayName: normaliseName(pick(row, "customer_name", "display_name")),
    email: pick(row, "customer_email", "email")?.toLowerCase() ?? null,
    phone: phone ? (normalisePhone(phone) ?? null) : null,
    name: normaliseName(name),
  };
}

/** Case and inner whitespace are not identity; everything else is. */
export function normaliseName(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return trimmed || null;
}

/** The last ten digits, or null when there are not ten to take. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * The address on the job row.
 *
 * Keyed on the street rather than an id, because the export has no address id.
 * Two jobs at the same house therefore resolve to one property, which is the
 * point — a property is a place, and its cleaning history is what makes
 * continuity and the price audit work.
 */
function jobAddress(row: Record<string, string>): MappedAddress | null {
  const street = pick(row, "street", "address_line_1", "service_address");
  const zip = pick(row, "zipcode", "zip", "zip_code", "postal_code");
  if (!street || !zip) return null;

  const normalised = street.toLowerCase().replace(/\s+/g, " ").trim();
  const unit = pick(row, "street_2", "address_line_2");

  return {
    // The street and postcode ARE the identity. Deliberately not the job id:
    // keying on that would make a new property for every visit to one house.
    hcpAddressId: `${normalised}${unit ? ` ${unit.toLowerCase().trim()}` : ""}:${zip}`,
    street: unit ? `${street} ${unit}` : street,
    city: pick(row, "city", "service_city") ?? "",
    state: pick(row, "state", "service_state") ?? "TX",
    zip,
  };
}
