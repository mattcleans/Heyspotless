import { describe, expect, it } from "vitest";
import {
  mapCustomer,
  mapFrequency,
  mapJob,
  mapJobStatus,
  mapService,
  normaliseZip,
  parseExportDate,
  parseMoneyCents,
  parseRoomCounts,
  phoneDigits,
  resolveInstant,
} from "./hcp";

/**
 * Every case here is a row that would otherwise be imported wrongly and
 * silently. A migration does not fail loudly; it bills somebody the wrong
 * amount every fortnight until they notice.
 */

describe("parseMoneyCents", () => {
  it("reads the formats an export actually writes", () => {
    expect(parseMoneyCents("$1,250.00")).toBe(125000);
    expect(parseMoneyCents("1250.00")).toBe(125000);
    expect(parseMoneyCents("1250")).toBe(125000);
    expect(parseMoneyCents("170.50")).toBe(17050);
  });

  /** parseFloat("$1,250.00") is NaN, and a NaN that becomes 0 is a free clean. */
  it("refuses rather than returning zero for something unreadable", () => {
    expect(parseMoneyCents("n/a")).toBeNull();
    expect(parseMoneyCents("")).toBeNull();
    expect(parseMoneyCents(null)).toBeNull();
    expect(parseMoneyCents("TBD")).toBeNull();
  });

  it("reads a parenthesised credit as negative", () => {
    expect(parseMoneyCents("(50.00)")).toBe(-5000);
  });

  it("does not lose a cent to floating point", () => {
    expect(parseMoneyCents("0.29")).toBe(29);
    expect(parseMoneyCents("362.70")).toBe(36270);
  });
});

describe("parseExportDate", () => {
  it("reads ISO", () => {
    expect(parseExportDate("2026-09-17 10:00")).toEqual({ date: "2026-09-17", time: "10:00" });
    expect(parseExportDate("2026-09-17")).toEqual({ date: "2026-09-17", time: null });
  });

  it("reads the US format the dashboard exports", () => {
    expect(parseExportDate("9/17/2026 10:00 AM")).toEqual({ date: "2026-09-17", time: "10:00" });
  });

  /** The two everybody gets backwards. */
  it("gets noon and midnight right", () => {
    expect(parseExportDate("9/17/2026 12:00 PM")?.time).toBe("12:00");
    expect(parseExportDate("9/17/2026 12:30 AM")?.time).toBe("00:30");
  });

  it("converts afternoon times", () => {
    expect(parseExportDate("9/17/2026 2:15 PM")?.time).toBe("14:15");
  });

  it("is null for something that is not a date", () => {
    expect(parseExportDate("soon")).toBeNull();
    expect(parseExportDate(null)).toBeNull();
  });
});

describe("mapService", () => {
  /** "Deep Clean - Move Out" is a move-out. Checking "deep" first misprices it. */
  it("reads a move-out as a move-out even when it says deep", () => {
    expect(mapService("Deep Clean - Move Out")).toBe("move_in_out");
    expect(mapService("Move In Clean")).toBe("move_in_out");
  });

  it("reads the other two", () => {
    expect(mapService("Deep Clean")).toBe("deep");
    expect(mapService("Standard Clean")).toBe("standard");
    expect(mapService("Recurring maintenance clean")).toBe("standard");
  });

  it("is null for something unrecognised", () => {
    expect(mapService("Carpet shampoo")).toBeNull();
  });
});

describe("mapFrequency", () => {
  /**
   * THE ONE THAT MATTERS MOST. "Every other week" contains "week". Reading it
   * as weekly doubles that customer's visits and halves the price of each.
   */
  it("reads every-other-week as fortnightly, not weekly", () => {
    expect(mapFrequency("Every other week")).toBe("biweekly");
    expect(mapFrequency("Every 2 weeks")).toBe("biweekly");
    expect(mapFrequency("Bi-weekly")).toBe("biweekly");
  });

  it("reads monthly before it reads weekly", () => {
    expect(mapFrequency("Monthly")).toBe("monthly");
    expect(mapFrequency("Every 4 weeks, monthly billing")).toBe("monthly");
  });

  it("reads the plain cases", () => {
    expect(mapFrequency("Weekly")).toBe("weekly");
    expect(mapFrequency("One-time")).toBe("one_time");
  });

  /** "We assumed one-time" is not a defence for billing somebody wrongly. */
  it("refuses rather than guessing", () => {
    expect(mapFrequency("as needed")).toBeNull();
    expect(mapFrequency(null)).toBeNull();
  });
});

describe("mapJobStatus", () => {
  it("recognises finished and cancelled", () => {
    expect(mapJobStatus("Completed")).toBe("complete");
    expect(mapJobStatus("Paid")).toBe("complete");
    expect(mapJobStatus("Canceled")).toBe("canceled");
  });

  /**
   * The asymmetry is deliberate: a finished job imported as scheduled puts a
   * clean that already happened onto the dispatch board.
   */
  it("treats anything else as still to come", () => {
    expect(mapJobStatus("In Progress")).toBe("scheduled");
    expect(mapJobStatus(null)).toBe("scheduled");
  });
});

describe("mapCustomer", () => {
  it("maps a row with a person's name", () => {
    const mapped = mapCustomer({
      customer_id: "hcp-1",
      first_name: "Dana",
      last_name: "Reyes",
      mobile_number: "(214) 555-0143",
      street: "9 Reply Rd",
      city: "Plano",
      zip: "75024",
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.firstName).toBe("Dana");
    expect(mapped.value.address?.zip).toBe("75024");
  });

  /** An agency managing a rental has no first name and is still a customer. */
  it("keeps a company with no personal name", () => {
    const mapped = mapCustomer({ customer_id: "hcp-2", company: "Northside Rentals" });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.firstName).toBe("Northside Rentals");
  });

  it("refuses a row with no id", () => {
    expect(mapCustomer({ first_name: "Dana" })).toMatchObject({ ok: false, problem: "no customer id" });
  });

  it("refuses a row with no name at all", () => {
    expect(mapCustomer({ customer_id: "hcp-3" }).ok).toBe(false);
  });

  it("gives an address a key stable enough to re-run against", () => {
    const first = mapCustomer({ customer_id: "x", first_name: "A", street: "9 Reply  Rd", zip: "75024" });
    const again = mapCustomer({ customer_id: "x", first_name: "A", street: "9 REPLY RD", zip: "75024" });
    if (!first.ok || !again.ok) throw new Error("expected both to map");
    expect(first.value.address?.hcpAddressId).toBe(again.value.address?.hcpAddressId);
  });
});

describe("mapJob", () => {
  it("maps a completed job", () => {
    const mapped = mapJob({
      job_id: "job-1",
      customer_id: "hcp-1",
      line_items: "Standard Clean",
      recurrence: "Every other week",
      total: "$170.00",
      status: "Completed",
      scheduled_start: "9/15/2026 10:00 AM",
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.priceCents).toBe(17000);
    expect(mapped.value.frequency).toBe("biweekly");
    expect(mapped.value.status).toBe("complete");
    // 10:00 in Dallas, as an instant: CDT is five hours behind UTC.
    expect(mapped.value.completedAt).toBe("2026-09-15T15:00:00.000Z");
  });

  /**
   * Inferring a completion from a past date would make every old scheduled job
   * an incumbency, and continuity would hand houses to whoever was last
   * pencilled in.
   */
  it("gives a scheduled job no completion time however old it is", () => {
    const mapped = mapJob({
      job_id: "job-2",
      customer_id: "hcp-1",
      total: "170",
      status: "Scheduled",
      scheduled_start: "1/2/2020 10:00 AM",
    });
    if (!mapped.ok) throw new Error("expected it to map");
    expect(mapped.value.completedAt).toBeNull();
  });

  it("refuses a job whose price cannot be read", () => {
    const mapped = mapJob({ job_id: "job-3", customer_id: "hcp-1", total: "see invoice" });
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.problem).toContain("no readable price");
  });

  it("refuses a job with no customer", () => {
    expect(mapJob({ job_id: "job-4", total: "170" }).ok).toBe(false);
  });
});

/**
 * THE 2026 EXPORT. Every alias below is a heading from the real Housecall Pro
 * export of 28 September 2026, after `normaliseHeader`. The first dry run
 * against it skipped every one of 1,781 jobs for "no job id", and would have
 * imported 977 customers without a single address.
 */
describe("the 2026 export's customer columns", () => {
  const row = {
    first_name: "Paula",
    last_name: "Marsh",
    display_name: "Paula Marsh",
    mobile_number: "(214) 555-0101",
    home_number: "972-555-0199",
    email: "Paula@Example.com",
    additional_emails: "p.marsh@example.com, paula@example.com",
    notes: "Back door sticks",
    id: "131736465",
    customer_created_at: "2024-06-03T17:30:12Z",
    do_not_service: "false",
    address_1_street_line_1: "100 Oak St",
    address_1_street_line_2: "",
    address_1_city: "Fort Worth",
    address_1_state: "TX",
    address_1_postal_code: "76129-0006",
    address_2_street_line_1: "12 Lake Rd",
    address_2_street_line_2: "Apt 4",
    address_2_city: "Granbury",
    address_2_state: "TX",
    address_2_postal_code: "76048",
  };

  it("reads the id from `ID`", () => {
    const mapped = mapCustomer(row);
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.hcpId).toBe("131736465");
  });

  it("reads the address from the Address_1 block, ZIP+4 as five digits", () => {
    const mapped = mapCustomer(row);
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address).toEqual({
      hcpAddressId: "131736465:100 oak st",
      line1: "100 Oak St",
      street: "100 Oak St",
      city: "Fort Worth",
      state: "TX",
      zip: "76129",
    });
  });

  /** 27 customers in the real export have a second address. */
  it("reads every Address_N block as its own address, line 2 kept out of the key", () => {
    const mapped = mapCustomer(row);
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.addresses).toHaveLength(2);
    expect(mapped.value.addresses[1]).toMatchObject({
      hcpAddressId: "131736465:12 lake rd",
      street: "12 Lake Rd, Apt 4",
      zip: "76048",
    });
  });

  it("skips an address block with no street or no ZIP", () => {
    const mapped = mapCustomer({ ...row, address_2_postal_code: "" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.addresses).toHaveLength(1);
  });

  /** 452 customers in the real export have no usable address. They are still customers. */
  it("imports a customer with no address at all", () => {
    const mapped = mapCustomer({ id: "1", first_name: "No", last_name: "Address" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address).toBeNull();
    expect(mapped.value.addresses).toEqual([]);
  });

  it("reads first contact from `Customer created at`, as a Dallas calendar day", () => {
    const mapped = mapCustomer({ ...row, customer_created_at: "2024-06-04T03:30:00Z" });
    if (!mapped.ok) throw new Error(mapped.problem);
    // 03:30 UTC on the 4th is 22:30 on the 3rd in Dallas.
    expect(mapped.value.firstContactDate).toBe("2024-06-03");
  });

  it("collects every email, lower-cased and de-duplicated, for linking", () => {
    const mapped = mapCustomer(row);
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.emails).toEqual(["paula@example.com", "p.marsh@example.com"]);
    expect(mapped.value.email).toBe("Paula@Example.com");
  });

  it("falls back to the home and then the work number for the phone", () => {
    const home = mapCustomer({ id: "1", first_name: "A", home_number: "972-555-0106" });
    const work = mapCustomer({ id: "2", first_name: "B", work_number: "469-555-0105" });
    if (!home.ok || !work.ok) throw new Error("expected both to map");
    expect(home.value.phone).toBe("972-555-0106");
    expect(home.value.homeDigits).toBe("9725550106");
    expect(home.value.mobileDigits).toBeNull();
    expect(work.value.phone).toBe("469-555-0105");
  });

  it("carries Do Not Service into the notes, since customers has no column for it", () => {
    const mapped = mapCustomer({ ...row, do_not_service: "true" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.doNotService).toBe(true);
    expect(mapped.value.notes).toBe("Back door sticks\n[HCP] Do not service");

    const none = mapCustomer({ id: "3", first_name: "C", do_not_service: "true" });
    if (!none.ok) throw new Error(none.problem);
    expect(none.value.notes).toBe("[HCP] Do not service");
  });

  /** 169 customers in the real export are unconverted leads named after their number. */
  it("flags a customer whose name is a phone number, and still imports them", () => {
    const mapped = mapCustomer({ id: "4", first_name: "(817) 555-0104", display_name: "(817) 555-0104" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.nameLooksLikePhone).toBe(true);
  });

  it("uses Display Name when there is no first name or company", () => {
    const mapped = mapCustomer({ id: "5", display_name: "The Hendersons" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.firstName).toBe("The Hendersons");
  });
});

describe("the 2026 export's job columns", () => {
  const row = {
    job: "52",
    customer_name: "Paula Marsh",
    customer_email: "Paula@Example.com",
    customer_mobile_number: "(214) 555-0101",
    job_description: "Standard Cleaning",
    job_status: "Completed",
    job_amount: "$154.00",
    job_scheduled_start_date: "2022-03-24T10:00:00-05:00",
    job_completed_date: "2022-03-24T12:40:00-05:00",
    recurring: "true",
    street: "100 Oak St",
    street_2: "",
    city: "Fort Worth",
    state: "TX",
    zipcode: "76129-0006",
    notes: "Use the side gate",
  };

  it("reads each field from its 2026 heading", () => {
    const mapped = mapJob(row);
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value).toMatchObject({
      hcpId: "52",
      hcpCustomerId: null,
      customerRef: { email: "paula@example.com", mobileDigits: "2145550101", name: "Paula Marsh" },
      service: "standard",
      serviceDefaulted: false,
      recurring: true,
      priceCents: 15400,
      status: "complete",
      statusRaw: "Completed",
      scheduledStart: "2022-03-24T15:00:00.000Z",
      scheduledDate: "2022-03-24",
      completedAt: "2022-03-24T17:40:00.000Z",
      notes: "Use the side gate",
      address: { line1: "100 Oak St", street: "100 Oak St", city: "Fort Worth", state: "TX", zip: "76129" },
    });
  });

  /** The export has no customer id; the job is linked on these instead (see link.ts). */
  it("maps a job with no customer id when it names its customer", () => {
    expect(mapJob({ ...row, customer_email: "", customer_mobile_number: "" }).ok).toBe(true);
  });

  it("reads `$0.00` as zero, not as unreadable", () => {
    const mapped = mapJob({ ...row, job_amount: "$0.00" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.priceCents).toBe(0);
  });

  it("reads `State` as the address's, never as the job status", () => {
    const mapped = mapJob({ ...row, job_status: "Scheduled", state: "TX" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.status).toBe("scheduled");
    expect(mapped.value.address?.state).toBe("TX");
  });

  it("gives In progress no completion time", () => {
    const mapped = mapJob({ ...row, job_status: "In progress" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.status).toBe("scheduled");
    expect(mapped.value.completedAt).toBeNull();
  });

  it("puts Street 2 on the street and keeps line 1 for matching", () => {
    const mapped = mapJob({ ...row, street_2: "Unit B" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address).toMatchObject({ line1: "100 Oak St", street: "100 Oak St, Unit B" });
  });

  it("has no address when the job has no street", () => {
    const mapped = mapJob({ ...row, street: "", city: "", zipcode: "" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address).toBeNull();
  });

  it("keeps a street with no ZIP, for the linker to report", () => {
    const mapped = mapJob({ ...row, zipcode: "" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address?.zip).toBeNull();
  });

  it("reads a missing scheduled date as null rather than a guess", () => {
    const mapped = mapJob({ ...row, job_status: "Scheduled", job_scheduled_start_date: "" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.scheduledStart).toBeNull();
    expect(mapped.value.scheduledDate).toBeNull();
  });

  it("refuses a job that names no customer in any way", () => {
    const mapped = mapJob({ job: "53", job_amount: "$10.00" });
    expect(mapped).toMatchObject({ ok: false, reason: "no customer reference" });
  });

  it("puts the unreadable value in the problem", () => {
    const mapped = mapJob({ ...row, job_amount: "see invoice" });
    expect(mapped).toMatchObject({ ok: false, reason: "no readable price", raw: "see invoice" });
  });
});

describe("parseExportDate with an offset", () => {
  it("takes a -05:00 value at its word", () => {
    expect(parseExportDate("2022-03-24T10:00:00-05:00")).toEqual({
      date: "2022-03-24",
      time: "10:00",
      instant: "2022-03-24T15:00:00.000Z",
    });
  });

  it("takes a -06:00 value at its word", () => {
    expect(parseExportDate("2022-01-10T09:30:00-06:00")).toEqual({
      date: "2022-01-10",
      time: "09:30",
      instant: "2022-01-10T15:30:00.000Z",
    });
  });

  /**
   * The case that shows why the offset has to win: a -06:00 value in July is
   * not what a Dallas clock read, and reading it as one is an hour out.
   */
  it("uses the offset, not the Dallas calendar, when they disagree", () => {
    const parsed = parseExportDate("2026-07-01T10:00:00-06:00");
    expect(parsed?.instant).toBe("2026-07-01T16:00:00.000Z");
    expect(parsed?.time).toBe("11:00");
  });

  it("reads UTC", () => {
    expect(parseExportDate("2024-06-03T17:30:12Z")?.instant).toBe("2024-06-03T17:30:12.000Z");
  });

  it("gives the Dallas calendar day of the instant", () => {
    expect(parseExportDate("2024-06-04T03:30:00Z")?.date).toBe("2024-06-03");
  });
});

describe("resolveInstant", () => {
  it("returns an offset value's own instant", () => {
    expect(resolveInstant(parseExportDate("2022-03-24T10:00:00-05:00"))).toBe("2022-03-24T15:00:00.000Z");
  });

  it("resolves a value with no offset through the Dallas calendar", () => {
    expect(resolveInstant(parseExportDate("9/17/2026 10:00 AM"))).toBe("2026-09-17T15:00:00.000Z");
    expect(resolveInstant(parseExportDate("1/5/2026 10:00 AM"))).toBe("2026-01-05T16:00:00.000Z");
  });

  it("puts a bare date at 09:00 Dallas", () => {
    expect(resolveInstant(parseExportDate("2026-09-17"))).toBe("2026-09-17T14:00:00.000Z");
  });

  /**
   * 2:30am on 8 March 2026 never happened in Dallas. It resolves to 3:00am CDT
   * — the moment the clocks skipped to — exactly as the importer always has.
   */
  it("still moves a time in the spring-forward gap to the moment after it", () => {
    expect(resolveInstant(parseExportDate("2026-03-08T02:30"))).toBe("2026-03-08T08:00:00.000Z");
    expect(resolveInstant(parseExportDate("3/8/2026 2:30 AM"))).toBe("2026-03-08T08:00:00.000Z");
  });

  it("is null for nothing", () => {
    expect(resolveInstant(null)).toBeNull();
  });
});

describe("mapService on the 2026 descriptions", () => {
  it.each([
    ["Standard Cleaning", "standard"],
    ["House Cleaning, 3 x Bedrooms, 2 x Full Baths, 0 x Half Baths", "standard"],
    ["Arrival", "standard"],
    ["AirBnB Turnover Clean", "standard"],
    ["Custom Quote", "standard"],
    ["Regular Cleaning Service ($280/visit)", "standard"],
    ["Deep Cleaning", "deep"],
    ["Move In/Out Cleaning", "move_in_out"],
  ])("reads %s as %s", (raw, service) => {
    expect(mapService(raw)).toBe(service);
  });

  it("still lets move-out beat deep, and deep beat standard", () => {
    expect(mapService("Deep Cleaning - Move Out")).toBe("move_in_out");
    expect(mapService("House Cleaning, Deep")).toBe("deep");
  });

  it("marks a job whose description matched nothing", () => {
    const mapped = mapJob({ job: "9", customer_name: "A B", job_amount: "$95.00", job_description: "Window washing" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.service).toBe("standard");
    expect(mapped.value.serviceDefaulted).toBe(true);
  });
});

describe("parseRoomCounts", () => {
  it("reads every count a House Cleaning description states", () => {
    expect(
      parseRoomCounts(
        "House Cleaning, 3 x Bedrooms, 2 x Full Baths, 0 x Half Baths, 1 x Kitchen, 0 x Utility Room, " +
          "1 x Living Room / Dining Room / Games Room, Inside the Fridge, Inside the Oven",
      ),
    ).toEqual({ bedrooms: 3, bathrooms: 2, halfBaths: 0, kitchens: 1, utilityRooms: 0, livingRooms: 1 });
  });

  it("reads singular and plural alike", () => {
    expect(parseRoomCounts("1 x Bedroom, 1 x Full Bath, 2 x Kitchens")).toMatchObject({
      bedrooms: 1,
      bathrooms: 1,
      kitchens: 2,
    });
  });

  /** Zero bedrooms is a studio, and a studio is priced. Not stated is not zero. */
  it("leaves a count the description does not state as null", () => {
    expect(parseRoomCounts("House Cleaning, 2 x Bedrooms")).toEqual({
      bedrooms: 2,
      bathrooms: null,
      halfBaths: null,
      kitchens: null,
      utilityRooms: null,
      livingRooms: null,
    });
  });

  it("is null for a description with no counts", () => {
    expect(parseRoomCounts("Standard Cleaning")).toBeNull();
    expect(parseRoomCounts(null)).toBeNull();
  });
});

describe("small readers", () => {
  it("compares phone numbers on their last ten digits", () => {
    expect(phoneDigits("(214) 555-0143")).toBe("2145550143");
    expect(phoneDigits("+1 214.555.0143")).toBe("2145550143");
    expect(phoneDigits("555-0143")).toBeNull();
  });

  it("reads ZIP+4 as its five-digit ZIP and leaves anything else alone", () => {
    expect(normaliseZip("76129-0006")).toBe("76129");
    expect(normaliseZip("761290006")).toBe("76129");
    expect(normaliseZip("75024")).toBe("75024");
    expect(normaliseZip("7502")).toBe("7502");
  });
});
