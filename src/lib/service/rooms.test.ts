import { describe, expect, it } from "vitest";
import { PHOTOS_PER_ROOM, requiredPhotoCount, roomsFor } from "./rooms";

describe("roomsFor", () => {
  it("enumerates a typical house in walk order", () => {
    const rooms = roomsFor({ bedrooms: 3, bathrooms: 2 });
    expect(rooms.map((r) => r.key)).toEqual([
      "kitchen_1",
      "bathroom_1",
      "bathroom_2",
      "living_room_1",
      "bedroom_1",
      "bedroom_2",
      "bedroom_3",
      "utility_room_1",
    ]);
  });

  it("drops the ordinal when there is only one of something", () => {
    // "Kitchen 1" reads like there is a second one somewhere.
    const rooms = roomsFor({ bedrooms: 1, bathrooms: 2 });
    expect(rooms.find((r) => r.key === "kitchen_1")?.label).toBe("Kitchen");
    expect(rooms.find((r) => r.key === "bathroom_1")?.label).toBe("Bathroom 1");
  });

  it("omits rooms the property does not have", () => {
    // A cleaner who cannot satisfy a requirement is one who cannot close out
    // her day, so an unphotographable room must never reach the list.
    const rooms = roomsFor({ bedrooms: 1, bathrooms: 1, utilityRooms: 0, halfBaths: 0 });
    expect(rooms.map((r) => r.key)).not.toContain("utility_room_1");
    expect(rooms.map((r) => r.key)).not.toContain("half_bath_1");
  });

  it("counts half baths as their own rooms", () => {
    // A Zillow "2.5 ba" is two full baths and a half, never a fractional one.
    const rooms = roomsFor({ bedrooms: 3, bathrooms: 2, halfBaths: 1 });
    expect(rooms.filter((r) => r.key.startsWith("bathroom_"))).toHaveLength(2);
    expect(rooms.filter((r) => r.key.startsWith("half_bath_"))).toHaveLength(1);
  });

  it("defaults the rooms every house has, and takes an override", () => {
    expect(roomsFor({ bedrooms: 0, bathrooms: 0 }).map((r) => r.key)).toEqual([
      "kitchen_1",
      "living_room_1",
      "utility_room_1",
    ]);
    expect(roomsFor({ bedrooms: 0, bathrooms: 0, kitchens: 2 })).toHaveLength(4);
  });

  it("keeps keys stable and ordinal, because photos are matched to them later", () => {
    // Renaming or reordering these silently orphans evidence taken weeks ago.
    const small = roomsFor({ bedrooms: 2, bathrooms: 1 });
    const large = roomsFor({ bedrooms: 4, bathrooms: 1 });
    expect(large.slice(0, small.length - 1).map((r) => r.key)).toEqual(
      small.slice(0, small.length - 1).map((r) => r.key),
    );
  });

  it("ignores a negative or fractional count rather than producing nonsense", () => {
    expect(roomsFor({ bedrooms: -2, bathrooms: 1.7 }).map((r) => r.key)).toEqual([
      "kitchen_1",
      "bathroom_1",
      "living_room_1",
      "utility_room_1",
    ]);
  });
});

describe("requiredPhotoCount", () => {
  it("is two per room", () => {
    expect(PHOTOS_PER_ROOM).toBe(2);
    // 3bd/2ba: kitchen, 2 baths, living, 3 beds, utility = 8 rooms.
    expect(requiredPhotoCount({ bedrooms: 3, bathrooms: 2 })).toBe(16);
  });

  it("scales the way a real job does", () => {
    // A 4bd/4ba move-out is eleven rooms and twenty-two photos, which is the
    // number that makes the offline upload queue load-bearing rather than
    // optional.
    expect(requiredPhotoCount({ bedrooms: 4, bathrooms: 4 })).toBe(22);
  });
});
