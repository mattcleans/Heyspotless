import { describe, expect, it } from "vitest";
import { reviewRooms, reviewState, isReviewId, type VisitFacts } from "./visit-review";
const rooms = { bedrooms: 0, bathrooms: 0, kitchens: 1, livingRooms: 0, utilityRooms: 0 };
const facts: VisitFacts = { startedAt:null,completedAt:null,invoicedAt:null,photos:[],issues:[],assignments:[],invoices:[] };
const complete = ["before","after"].map(kind=>({id:kind,kind,roomKey:"kitchen_1",takenAt:new Date()}));
describe("executive visit review", () => {
  it("does not treat a finished clean as invoiced when photos are missing", () => {
    expect(reviewState("complete",rooms,facts)).toMatchObject({key:"photos",gaps:[{missing:["before","after"]}]});
  });
  it("requires both correct room kinds rather than issue or unknown-room photos", () => {
    const photos = [{...complete[0]!,kind:"issue"},{...complete[1]!,roomKey:"unknown"}];
    expect(reviewState("complete",rooms,{...facts,photos})).toMatchObject({key:"photos"});
  });
  it("calls for invoice review when required evidence is recorded, without claiming payment", () => {
    expect(reviewState("complete",rooms,{...facts,photos:complete})).toMatchObject({key:"ready",label:"Ready for invoice review",gaps:[]});
  });
  it.each(["assigned","in_progress","canceled"])("keeps %s separate from completed work", status => {
    expect(reviewState(status,rooms,{...facts,photos:complete}).key).toBe("unfinished");
  });
  it("treats an actual invoice as recorded even when its timestamp is missing", () => {
    expect(reviewState("complete",rooms,{...facts,invoices:[{id:"i",status:"draft",totalCents:100,balanceCents:100}]}).key).toBe("recorded");
  });
  it("does not infer an accessible invoice from a timestamp alone", () => {
    expect(reviewState("complete",rooms,{...facts,invoicedAt:new Date()}).key).toBe("unavailable");
  });
  it.each([-1,0.5,NaN,1000000])("rejects unusable room count %s before constructing a photo list", bedrooms => {
    expect(()=>reviewRooms({...rooms,bedrooms})).toThrow("room counts");
  });
  it("supports zero-room configurations without fabricating evidence", () => {
    expect(reviewRooms({...rooms,kitchens:0})).toEqual([]);
  });
  it("accepts stored UUIDs and rejects sample/path identifiers for protected reads", () => {
    expect(isReviewId("95000000-0000-0000-0000-000000000001")).toBe(true);
    expect(isReviewId("review-sample-photos")).toBe(false);
    expect(isReviewId("../photos")).toBe(false);
  });
});
