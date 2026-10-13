import { describe, expect, it } from "vitest";
import { parseHomeInstructions } from "./home-instructions";
const empty = { gateCode: null, accessNotes: null, parkingNotes: null, pets: null };
describe("home instruction input", () => {
  it("trims new instructions and clears blank fields", () => {
    expect(parseHomeInstructions({ gateCode: " 1234 ", accessNotes: "\n Side door \t", parkingNotes: "  ", pets: null })).toEqual({ gateCode: "1234", accessNotes: "Side door", parkingNotes: null, pets: null });
  });
  it("preserves original whitespace and empty strings for exact conflict detection", () => {
    expect(parseHomeInstructions({ ...empty, gateCode: " 1234 ", accessNotes: "" }, false)).toEqual({ ...empty, gateCode: " 1234 ", accessNotes: "" });
  });
  it("never forwards ownership, addresses or room counts", () => {
    expect(parseHomeInstructions({ ...empty, customerId: "someone-else", street: "Other address", bedrooms: 99 })).toEqual(empty);
  });
  it.each([null, [], {}, { ...empty, pets: 4 }, { ...empty, gateCode: false }])("rejects missing or non-text fields %j", raw => {
    expect(() => parseHomeInstructions(raw)).toThrow();
  });
  it.each(["gateCode", "accessNotes", "parkingNotes", "pets"])("limits new %s values", field => {
    expect(() => parseHomeInstructions({ ...empty, [field]: "x".repeat(field === "gateCode" ? 201 : 1001) })).toThrow("characters or fewer");
  });
  it("allows an original legacy long value to be replaced rather than making conflict detection impossible", () => {
    expect(parseHomeInstructions({ ...empty, pets: "x".repeat(2000) }, false).pets).toHaveLength(2000);
  });
});
