import { describe, expect, it } from "vitest";
import { readVisitRoomScope, roomsForVisit } from "./visit-room-scope";
const identity = { id: "job", customerId: "client", propertyId: "home" };
const row = { job_id: "job", customer_id: "client", property_id: "home", bedrooms: 2, bathrooms: 1, half_baths: 1, kitchens: 1, living_rooms: 1, utility_rooms: 0, source: "client_booking", captured_at: "2026-10-01T10:00:00Z" };
describe("saved visit room scope", () => {
  it("preserves the agreed six counts independently from later home counts", () => {
    const roomScope = readVisitRoomScope(row, identity);
    const job = { ...identity, roomScope };
    expect(roomsForVisit(job)).toEqual({ bedrooms: 2, bathrooms: 1, halfBaths: 1, kitchens: 1, livingRooms: 1, utilityRooms: 0 });
    const editedHome = { bedrooms: 8, bathrooms: 8, kitchens: 3 };
    expect(roomsForVisit(job, editedHome)?.bedrooms).toBe(2);
  });
  it.each([null, [], [row, row], { ...row, job_id: "other" }, { ...row, customer_id: "other" }, { ...row, property_id: "other" }, { ...row, source: "guess" }, { ...row, captured_at: "bad" }])("does not treat %j as a confirmed visit scope", value => {
    expect(readVisitRoomScope(value, identity)).toBeNull();
  });
  it.each([-1, 0.5, "2", null, 251])("rejects malformed saved bedroom count %j", bedrooms => {
    expect(readVisitRoomScope({ ...row, bedrooms }, identity)).toBeNull();
  });
  it("distinguishes an explicit zero-room list from missing scope", () => {
    const scope = readVisitRoomScope({ ...row, bedrooms: 0, bathrooms: 0, half_baths: 0, kitchens: 0, living_rooms: 0, utility_rooms: 0 }, identity);
    expect(roomsForVisit({ ...identity, roomScope: scope })).not.toBeNull();
    expect(roomsForVisit(identity)).toBeNull();
  });
  it("refuses a room list after the visit is moved to another home or Client", () => {
    const scope = readVisitRoomScope(row, identity);
    expect(roomsForVisit({ ...identity, propertyId: "other", roomScope: scope })).toBeNull();
    expect(roomsForVisit({ ...identity, customerId: "other", roomScope: scope })).toBeNull();
  });
  it("allows an explicit sample-home fallback without labeling it as booked", () => {
    expect(roomsForVisit(identity, { bedrooms: 1, bathrooms: 1 })).toEqual({ bedrooms: 1, bathrooms: 1, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1 });
  });
});
