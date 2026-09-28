import { describe, expect, it } from "vitest";
import { cleanCell, normaliseHeader, parseCsv, pick, toRecords } from "./csv";

describe("parseCsv", () => {
  it("reads a plain file", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  /** Every address with a unit number. */
  it("keeps a comma inside a quoted field", () => {
    expect(parseCsv('name,address\n"Reyes","9 Reply Rd, Apt 4"')).toEqual([
      ["name", "address"],
      ["Reyes", "9 Reply Rd, Apt 4"],
    ]);
  });

  /**
   * The one that silently corrupts an import: splitting on newlines first turns
   * one customer into three broken rows, and the broken ones look enough like
   * data to be written.
   */
  it("keeps a newline inside a quoted field", () => {
    const rows = parseCsv('name,notes\n"Reyes","gate code 1234\nback door sticks"\n"Okafor","none"');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.[1]).toBe("gate code 1234\nback door sticks");
    expect(rows[2]?.[0]).toBe("Okafor");
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('notes\n"6"" baseboards"')[1]?.[0]).toBe('6" baseboards');
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a\n1\n")).toHaveLength(2);
  });

  /** Excel writes one, and without this the first column never matches. */
  it("strips a byte-order mark", () => {
    expect(parseCsv("﻿id,name\n1,a")[0]?.[0]).toBe("id");
  });

  it("keeps empty fields in place", () => {
    expect(parseCsv("a,b,c\n1,,3")[1]).toEqual(["1", "", "3"]);
  });

  it("survives an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("toRecords", () => {
  it("keys rows by normalised column name", () => {
    const records = toRecords(parseCsv("Customer ID,First Name\nabc,Dana"));
    expect(records).toEqual([{ customer_id: "abc", first_name: "Dana" }]);
  });

  /** Housecall Pro has changed these headings at least twice. */
  it("reads three spellings of one heading the same way", () => {
    for (const heading of ["Customer ID", "customer_id", "Customer Id"]) {
      expect(normaliseHeader(heading)).toBe("customer_id");
    }
  });

  it("drops blank rows", () => {
    expect(toRecords(parseCsv("a,b\n1,2\n,\n"))).toHaveLength(1);
  });

  it("trims whitespace around values", () => {
    expect(toRecords(parseCsv("a\n  spaced  "))[0]?.a).toBe("spaced");
  });
});

describe("pick", () => {
  it("takes the first heading that is present and non-empty", () => {
    const row = { customer_id: "", client_id: "abc" };
    expect(pick(row, "customer_id", "client_id")).toBe("abc");
  });

  it("is null when none of them are there", () => {
    expect(pick({}, "customer_id")).toBeNull();
  });
});

/**
 * Housecall Pro writes `Job #` as `="52"` so a spreadsheet keeps it as text.
 * Read literally, no job id ever matches anything.
 */
describe("cleanCell", () => {
  it("strips the Excel =\"…\" wrapper", () => {
    expect(cleanCell('="52"')).toBe("52");
    expect(cleanCell(' ="0052" ')).toBe("0052");
  });

  it("leaves an ordinary value alone, trimmed", () => {
    expect(cleanCell("  52 ")).toBe("52");
    expect(cleanCell("=SUM(A1)")).toBe("=SUM(A1)");
    expect(cleanCell('"quoted"')).toBe('"quoted"');
    expect(cleanCell("")).toBe("");
  });

  it("unescapes a doubled quote inside the wrapper", () => {
    expect(cleanCell('="6"" baseboards"')).toBe('6" baseboards');
  });

  it("is applied to every column by toRecords, in both ways a CSV can write it", () => {
    const records = toRecords(parseCsv('Job #,Zipcode\n="52",="07601"\n"=""53""",75024'));
    expect(records).toEqual([
      { job: "52", zipcode: "07601" },
      { job: "53", zipcode: "75024" },
    ]);
  });
});

describe("normaliseHeader on the 2026 export", () => {
  it.each([
    ["Job #", "job"],
    ["ID", "id"],
    ["Customer created at", "customer_created_at"],
    ["Do Not Service", "do_not_service"],
    ["Address_1 Street Line 1", "address_1_street_line_1"],
    ["Address_1 Postal Code", "address_1_postal_code"],
    ["Address_3 Billing?", "address_3_billing"],
    ["Job scheduled start date", "job_scheduled_start_date"],
    ["Customer mobile number", "customer_mobile_number"],
    ["Street 2", "street_2"],
  ])("reads %s as %s", (heading, key) => {
    expect(normaliseHeader(heading)).toBe(key);
  });
});
