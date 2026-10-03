import { describe, expect, it } from "vitest";
import { recordedRooms, trackedRooms, finishEstimate } from "./customer-visit";
import { visitStage, isStageReached, roomProgress, visitHeadline, type VisitSummary } from "./progress";
const counts={bedrooms:1,bathrooms:1,halfBaths:1,kitchens:2,livingRooms:0,utilityRooms:0};
const visit:VisitSummary={stage:"cleaning",scheduledStart:null,startedAt:null,completedAt:null,expectedFinishAt:new Date("2026-10-01T16:00:00Z"),roomsDone:1,roomsTotal:5};
describe("client visit truth",()=>{
  it("includes configured extra kitchens, half baths and zero room types",()=>{
    expect(trackedRooms(counts).map(r=>r.key)).toEqual(["kitchen_1","kitchen_2","bathroom_1","half_bath_1","bedroom_1"]);
  });
  it("counts only a required before-and-after pair, ignoring issue, extra and duplicate photos",()=>{
    const rooms=recordedRooms(counts,[
      {roomKey:"kitchen_1",kind:"before"},{roomKey:"kitchen_1",kind:"before"},
      {roomKey:"kitchen_2",kind:"before"},{roomKey:"kitchen_2",kind:"after"},
      {roomKey:"bathroom_1",kind:"issue"},{roomKey:"half_bath_1",kind:"after"},
      {roomKey:"unknown_1",kind:"before"},{roomKey:"unknown_1",kind:"after"},
    ]);
    expect(rooms.filter(r=>r.recorded).map(r=>r.key)).toEqual(["kitchen_2"]);
  });
  it.each([-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER])("rejects invalid or excessive room count %s before constructing a list",bedrooms=>{
    expect(()=>trackedRooms({...counts,bedrooms})).toThrow("room details");
  });
  it("supports an explicitly zero-room property without a fabricated checklist",()=>{
    expect(trackedRooms({bedrooms:0,bathrooms:0,kitchens:0,livingRooms:0,utilityRooms:0})).toEqual([]);
  });
  it("makes cancellation override started-at and assignment history",()=>{
    expect(visitStage("canceled",new Date(),true)).toBe("canceled");
    expect(visitHeadline({...visit,stage:"canceled"},"Maria")).toBe("This visit was canceled");
    expect(isStageReached("cleaning","canceled")).toBe(false);expect(roomProgress({...visit,stage:"canceled"})).toBeNull();
  });
  it("separates completed work from photos awaiting upload",()=>{
    expect(visitStage("complete",null,false)).toBe("done");expect(roomProgress({...visit,stage:"done"})).toBe(0.2);
  });
  it.each(["unscheduled","scheduled","dispatching"])("shows matching for %s without assignment",status=>{
    expect(visitStage(status,null,false)).toBe("scheduled");
  });
  it("recognizes assigned and active visits without fabricating their timestamps",()=>{
    expect(visitStage("assigned",null,false)).toBe("accepted");expect(visitStage("scheduled",null,true)).toBe("accepted");
    expect(visitStage("in_progress",null,false)).toBe("cleaning");
  });
  it("rejects unknown status",()=>{expect(()=>visitStage("bad",null,false)).toThrow("status");});
  it("recognizes passed estimates while leaving completion to the recorded status",()=>{
    expect(finishEstimate(visit,new Date("2026-10-01T16:00:00Z"))).toBe("passed");
    expect(finishEstimate(visit,new Date("2026-10-01T15:00:00Z"))).toBe("upcoming");
    expect(finishEstimate({...visit,stage:"done"},new Date())).toBeNull();expect(finishEstimate({...visit,expectedFinishAt:null},new Date())).toBeNull();
  });
  it.each([-1,NaN,0.5])("hides invalid progress %s",roomsDone=>{expect(roomProgress({...visit,roomsDone})).toBeNull();});
});
