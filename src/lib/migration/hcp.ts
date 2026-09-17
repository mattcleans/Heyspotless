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
  email: string | null;
  phone: string | null;
  notes: string | null;
  firstContactDate: string | null;
  address: {
    hcpAddressId: string;
    street: string;
    city: string;
    state: string;
    zip: string;
  } | null;
}

export interface MappedJob {
  hcpId: string;
  hcpCustomerId: string;
  service: ServiceType;
  frequency: Frequency;
  priceCents: number;
  status: "scheduled" | "complete" | "canceled";
  scheduledStart: string | null;
  completedAt: string | null;
  notes: string | null;
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
 * NO ZONE IS INVENTED. An export's `2026-09-17 10:00` is a wall-clock time in
 * Dallas, and the caller resolves it through the business calendar — the same
 * path every other date in this system takes. A bare date with no time is
 * returned as a calendar date, because midnight is not what was meant.
 */
export function parseExportDate(raw: string | null): { date: string; time: string | null } | null {
  if (!raw) return null;

  const trimmed = raw.trim();

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

  const street = pick(row, "street", "address", "address_line_1", "service_address", "street_1");
  const zip = pick(row, "zip", "zip_code", "postal_code");

  return {
    ok: true,
    value: {
      hcpId,
      firstName: first ?? company ?? "",
      lastName: last ?? "",
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
              city: pick(row, "city", "service_city") ?? "",
              state: pick(row, "state", "service_state") ?? "TX",
              zip,
            }
          : null,
    },
  };
}

export function mapJob(row: Record<string, string>): Mapped<MappedJob> {
  const hcpId = pick(row, "job_id", "invoice_number", "id");
  if (!hcpId) return { ok: false, problem: "no job id" };

  const hcpCustomerId = pick(row, "customer_id", "client_id");
  if (!hcpCustomerId) return { ok: false, problem: `job ${hcpId}: no customer id` };

  const serviceRaw = pick(row, "line_items", "service", "job_type", "description", "name");
  const service = mapService(serviceRaw) ?? "standard";

  const frequencyRaw = pick(row, "recurrence", "frequency", "schedule", "job_type", "line_items");
  // A one-off job is the honest default for a JOB (a plan is different, and
  // `mapFrequency` returning null there is fatal on purpose) — what it changes
  // is which column of the price book a re-quote would read, not what the
  // customer is charged, because the price comes across as it was.
  const frequency = mapFrequency(frequencyRaw) ?? "one_time";

  const priceCents = parseMoneyCents(
    pick(row, "total", "amount", "invoice_total", "price", "job_total"),
  );
  if (priceCents === null) return { ok: false, problem: `job ${hcpId}: no readable price` };

  const status = mapJobStatus(pick(row, "status", "job_status", "state"));
  const scheduled = parseExportDate(pick(row, "scheduled_start", "start_date", "scheduled_date", "date"));
  const completed = parseExportDate(pick(row, "completed_at", "completed_date", "end_date"));

  return {
    ok: true,
    value: {
      hcpId,
      hcpCustomerId,
      service,
      frequency,
      priceCents,
      status,
      scheduledStart: scheduled ? `${scheduled.date}T${scheduled.time ?? "09:00"}` : null,
      // Only a job that says it finished gets a completion time. Inferring one
      // from a past date would make every old scheduled job an incumbency.
      completedAt:
        status === "complete"
          ? `${(completed ?? scheduled)?.date ?? ""}T${(completed ?? scheduled)?.time ?? "09:00"}`
          : null,
      notes: pick(row, "notes", "job_notes", "description"),
    },
  };
}
