import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
const m=vi.hoisted(()=>({profile:vi.fn(),cleaner:vi.fn(),record:vi.fn(),photos:vi.fn(),home:vi.fn(),job:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:async()=>({getCurrentProfile:m.profile,getCleanerByProfile:m.cleaner,getJob:m.job,getProperty:m.home})}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({})}));
vi.mock("@/lib/service/store",()=>({PhotoReceiptError:class extends Error{},ServiceStore:class{recordPhoto=m.record;photosFor=m.photos;}}));
import { POST } from "./route";
const body={jobId:"job",roomKey:"kitchen_1",kind:"before",storagePath:"jobs/job/kitchen_1-before.jpg"};
const request=()=>new NextRequest("https://example.test/api/jobs/photo",{method:"POST",body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();m.profile.mockResolvedValue({id:"profile",role:"cleaner"});m.cleaner.mockResolvedValue({id:"cleaner"});m.record.mockResolvedValue("photo");m.photos.mockResolvedValue([]);m.job.mockResolvedValue({id:"job",status:"complete",propertyId:"home",bedrooms:0,bathrooms:0});m.home.mockResolvedValue({rooms:{bedrooms:0,bathrooms:0,kitchens:1,livingRooms:0,utilityRooms:0,halfBaths:1}});});
describe("durable photo receipt",()=>{
 it("never acknowledges a missing database receipt",async()=>{m.record.mockResolvedValue(null);const response=await POST(request());expect(response.status).toBe(409);expect(await response.json()).toMatchObject({recorded:false});});
 it("returns the exact identity needed before discarding a local copy",async()=>{expect(await(await POST(request())).json()).toMatchObject({...body,photoId:"photo",recorded:true});});
 it("keeps a half bath in the actual home's outstanding requirements",async()=>{expect(await(await POST(request())).json()).toMatchObject({billable:false,outstanding:expect.arrayContaining([expect.objectContaining({room:"half_bath_1"})])});});
 it.each([null,{id:"profile",role:"customer"},{id:"profile",role:"admin"}])("refuses %j before recording",async profile=>{m.profile.mockResolvedValue(profile);expect((await POST(request())).ok).toBe(false);expect(m.record).not.toHaveBeenCalled();});
 it("does not expose internal recording errors or invent persistence",async()=>{m.record.mockRejectedValue(new Error("private database diagnostic"));const response=await POST(request());expect(response.status).toBe(503);const text=await response.text();expect(text).not.toContain("private database");expect(text).toContain('"recorded":false');});
});
