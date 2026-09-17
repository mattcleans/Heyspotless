import { describe, expect, it } from "vitest";
import { normaliseHeader, parseCsv, pick, toRecords } from "./csv";

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
