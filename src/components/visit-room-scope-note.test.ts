import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VisitRoomScopeNote } from "./visit-room-scope-note";
import type { VisitRoomScope } from "@/lib/service/visit-room-scope";
const scope: VisitRoomScope = { jobId: "job", customerId: "client", propertyId: "home", source: "client_booking", capturedAt: new Date("2026-10-01T10:00:00Z"), rooms: { bedrooms: 1, bathrooms: 2, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 0 } };
describe("room-list provenance", () => {
  it("names a confirmed booking and displays all six counts", () => {
    const html = renderToStaticMarkup(createElement(VisitRoomScopeNote, { scope, showCounts: true }));
    expect(html).toContain("confirmed booking terms");
    expect(html).toContain("1 bedroom, 2 full baths, 0 half baths, 1 kitchen, 1 living room, 0 utility rooms");
  });
  it("does not label a legacy baseline as a historic agreement", () => {
    const html = renderToStaticMarkup(createElement(VisitRoomScopeNote, { scope: { ...scope, source: "legacy_home" }, office: true }));
    expect(html).toContain("Original booked counts were unavailable");
    expect(html).not.toContain("confirmed booking terms");
  });
  it("does not replace an unknown scope with current home details", () => {
    expect(renderToStaticMarkup(createElement(VisitRoomScopeNote, { scope: null }))).toContain("needs office review");
  });
});
