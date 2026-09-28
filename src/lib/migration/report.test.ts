import { describe, expect, it } from "vitest";
import { EXAMPLES_PER_REASON, formatTally, maskName, maskValue, Tally } from "./report";

describe("maskName", () => {
  it("keeps the first letter of each word", () => {
    expect(maskName("Paula Martinez")).toBe("P**** M****");
    expect(maskName("Northside Rentals LLC")).toBe("N**** R**** L****");
  });

  it("keeps only the last four digits of a name that is a phone number", () => {
    expect(maskName("(817) 555-0104")).toBe("phone …0104");
  });

  it("says when there is no name", () => {
    expect(maskName("")).toBe("(no name)");
    expect(maskName(null)).toBe("(no name)");
  });
});

describe("maskValue", () => {
  it("masks emails and phone numbers and leaves the rest", () => {
    expect(maskValue("paula@example.com / 2145550101")).toBe("p****@example.com / ***-***-0101");
    expect(maskValue("call (214) 555-0101 after 5")).toBe("call ***-***-0101 after 5");
  });

  it("leaves dates, ZIP+4 and money alone", () => {
    expect(maskValue("Scheduled 2026-09-01")).toBe("Scheduled 2026-09-01");
    expect(maskValue("76129-0006")).toBe("76129-0006");
    expect(maskValue("$1,250.00")).toBe("$1,250.00");
  });
});

describe("Tally", () => {
  it("counts every row but keeps only the first few examples", () => {
    const tally = new Tally();
    for (let i = 0; i < 8; i++) tally.add("no matching customer", { ref: `job ${i}`, name: "A****", raw: "" });
    tally.add("no address", { ref: "job 99", name: "B****", raw: "" });
    const [first, second] = tally.list();
    expect(first).toMatchObject({ reason: "no matching customer", count: 8 });
    expect(first?.examples).toHaveLength(EXAMPLES_PER_REASON);
    expect(second).toMatchObject({ reason: "no address", count: 1 });
    expect(tally.total).toBe(9);
  });

  it("formats with the masked raw value", () => {
    const tally = new Tally();
    tally.add("no matching customer", { ref: "job 60", name: "Z**** U****", raw: "zed@nowhere.example" });
    expect(formatTally("not imported, by reason", tally)).toEqual([
      "not imported, by reason:",
      "  [1] no matching customer",
      '        job 60 · Z**** U**** · "z****@nowhere.example"',
    ]);
  });
});
