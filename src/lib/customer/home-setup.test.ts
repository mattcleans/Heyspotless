import { describe, expect, it } from "vitest";
import { parseHomeSetup, savedHome } from "./home-setup";
const input = { id: "d9100000-0000-4000-8000-000000000001", home: { street: " 100 Test Way ", city: " Dallas ", state: "tx", zip: "75201", bedrooms: 2, bathrooms: 2, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1 }, contact: { firstName: "Test", lastName: "Client", phone: "+1 (469) 555-0100" } };
describe("Client home review", () => {
  it("normalizes the exact address and contact reviewed for saving", () => {
    const result = parseHomeSetup(input); expect(result.home.street).toBe("100 Test Way"); expect(result.home.state).toBe("TX"); expect(result.contact?.phone).toBe(input.contact.phone);
  });
  it.each([null, [], { ...input, customerId: "other" }, { ...input, id: "foreign" }, { ...input, home: { ...input.home, gateCode: "123" } }, { ...input, home: { ...input.home, bedrooms: -1 } }, { ...input, home: { ...input.home, bathrooms: 1.5 } }, { ...input, home: { ...input.home, zip: "752" } }, { ...input, contact: { ...input.contact, phone: "abcdefg" } }])("refuses malformed or identity-bearing input %j", value => { expect(() => parseHomeSetup(value)).toThrow(); });
  it("allows an existing Client to leave saved contact details untouched", () => { expect(parseHomeSetup({ ...input, contact: null }).contact).toBeNull(); });
  it("accepts only a saved result matching every reviewed address and room field", () => {
    const requested = parseHomeSetup(input), result = { id: input.id, customerId: "d9200000-0000-4000-8000-000000000001", home: requested.home };
    expect(savedHome(result, requested).id).toBe(input.id);
    expect(() => savedHome({ ...result, home: { ...result.home, bedrooms: 3 } }, requested)).toThrow();
    expect(() => savedHome({ ...result, id: null }, requested)).toThrow();
  });
});
