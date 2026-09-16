import { describe, expect, it } from "vitest";
import { invoiceReadiness, photoGaps, photoRequirementMet } from "./completion";
import { roomsFor } from "./rooms";

const FLAT = { bedrooms: 1, bathrooms: 1, utilityRooms: 0 };

/** Every room photographed both ways. */
function fullSet(counts: Parameters<typeof roomsFor>[0]) {
  return roomsFor(counts).flatMap((room) => [
    { roomKey: room.key, kind: "before" },
    { roomKey: room.key, kind: "after" },
  ]);
}

describe("photoGaps", () => {
  it("is empty when every room has both", () => {
    expect(photoGaps(FLAT, fullSet(FLAT))).toEqual([]);
    expect(photoRequirementMet(FLAT, fullSet(FLAT))).toBe(true);
  });

  it("names the rooms and what is missing from each", () => {
    // The answer goes onto a cleaner's screen as a list of what is left, not a
    // count she has to work out.
    const gaps = photoGaps(FLAT, [{ roomKey: "kitchen_1", kind: "before" }]);
    expect(gaps.map((g) => g.room.key)).toEqual(["kitchen_1", "bathroom_1", "living_room_1", "bedroom_1"]);
    expect(gaps[0]?.missing).toEqual(["after"]);
    expect(gaps[1]?.missing).toEqual(["before", "after"]);
  });

  it("reports gaps in walk order", () => {
    const gaps = photoGaps(FLAT, []);
    expect(gaps.map((g) => g.room.key)).toEqual(
      roomsFor(FLAT).map((r) => r.key),
    );
  });

  it("does not let an issue photo stand in for an after", () => {
    // A picture of a stain is not a picture of a clean room.
    const photos = [
      ...fullSet(FLAT).filter((p) => !(p.roomKey === "kitchen_1" && p.kind === "after")),
      { roomKey: "kitchen_1", kind: "issue" },
    ];
    const gaps = photoGaps(FLAT, photos);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toEqual(["after"]);
  });

  it("ignores a photo with no room on it", () => {
    // Evidence that cannot be attributed to a room satisfies no room.
    expect(photoGaps(FLAT, [{ roomKey: null, kind: "before" }])).toHaveLength(
      roomsFor(FLAT).length,
    );
  });

  it("is not fooled by two photos of the same kind in one room", () => {
    const photos = [
      { roomKey: "kitchen_1", kind: "before" },
      { roomKey: "kitchen_1", kind: "before" },
    ];
    expect(photoGaps(FLAT, photos)[0]?.missing).toEqual(["after"]);
  });

  it("ignores a photo of a room this property does not have", () => {
    const photos = [...fullSet(FLAT), { roomKey: "bedroom_9", kind: "after" }];
    expect(photoRequirementMet(FLAT, photos)).toBe(true);
  });
});

describe("invoiceReadiness", () => {
  it("refuses a job that is not finished, whatever the photos say", () => {
    const result = invoiceReadiness("assigned", FLAT, fullSet(FLAT));
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toBe("not_complete");
  });

  it("refuses a finished job with photos outstanding, and says which", () => {
    // "Complete but uninvoiced" is a real state: a clean finished three days
    // ago with no photos is either a cleaner who needs a nudge or revenue
    // quietly going uncollected, and a person should see both.
    const result = invoiceReadiness("complete", FLAT, []);
    expect(result.ready).toBe(false);
    if (result.ready || result.reason !== "photos_outstanding") return;
    expect(result.gaps).toHaveLength(roomsFor(FLAT).length);
  });

  it("is ready when the job is done and the evidence is in", () => {
    expect(invoiceReadiness("complete", FLAT, fullSet(FLAT)).ready).toBe(true);
  });

  it("can become ready later, which is why it is not checked only at completion", () => {
    // Photos upload late from a house with no signal, or drain out of the
    // offline queue afterwards. Checking once at completion would leave every
    // slow upload permanently uninvoiced.
    const partial = fullSet(FLAT).slice(0, -1);
    expect(invoiceReadiness("complete", FLAT, partial).ready).toBe(false);
    expect(invoiceReadiness("complete", FLAT, fullSet(FLAT)).ready).toBe(true);
  });
});
