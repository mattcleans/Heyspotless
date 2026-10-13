import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m=vi.hoisted(()=>({repo:vi.fn(),client:vi.fn(),single:vi.fn(),signed:vi.fn(),eq:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:m.repo}));vi.mock("@/lib/supabase/server",()=>({createClient:m.client}));
import {GET} from "./route";
const id="95000000-0000-0000-0000-000000000001",photoId="96000000-0000-0000-0000-000000000001";
const request=new NextRequest("https://app.example.test/api/admin/photo");
const get=(visitId=id,pid=photoId)=>GET(request,{params:Promise.resolve({id:visitId,photoId:pid})});
function account(role:string|null,demo=false){m.repo.mockResolvedValue({isDemo:demo,getCurrentProfile:async()=>role?{role}:null});}
beforeEach(()=>{
  vi.clearAllMocks();account("admin");
  const query={select:vi.fn(),eq:m.eq,maybeSingle:m.single};query.select.mockReturnValue(query);m.eq.mockReturnValue(query);
  m.client.mockResolvedValue({from:()=>query,storage:{from:()=>({createSignedUrl:m.signed})}});
  m.single.mockResolvedValue({data:{storage_path:`jobs/${id}/kitchen_1-before.jpg`},error:null});
  m.signed.mockResolvedValue({data:{signedUrl:"https://storage.example.test/signed/photo"},error:null});
});
describe("management photo access",()=>{
  it.each([[null,401],["customer",403],["cleaner",403]])("rejects role %s before reading storage",async(role,status)=>{
    account(role as string|null);expect((await get()).status).toBe(status);expect(m.client).not.toHaveBeenCalled();
  });
  it("does not generate photo access in demo mode",async()=>{account("admin",true);expect((await get()).status).toBe(404);expect(m.signed).not.toHaveBeenCalled();});
  it("rejects malformed ids before a database query",async()=>{expect((await get("../other")).status).toBe(404);expect(m.client).not.toHaveBeenCalled();});
  it("matches both photo and visit and creates only a one-minute private URL",async()=>{
    const result=await get();expect(result.status).toBe(303);expect(result.headers.get("location")).toBe("https://storage.example.test/signed/photo");
    expect(m.eq).toHaveBeenCalledWith("id",photoId);expect(m.eq).toHaveBeenCalledWith("job_id",id);
    expect(m.signed).toHaveBeenCalledWith(`jobs/${id}/kitchen_1-before.jpg`,60);
    expect(result.headers.get("cache-control")).toContain("no-store");expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each(["jobs/other/home.jpg",`jobs/${id}/../other.jpg`])("rejects stored path outside this visit: %s",async storage_path=>{
    m.single.mockResolvedValue({data:{storage_path},error:null});const result=await get();
    expect(result.headers.get("location")).toContain("photoError=unavailable");expect(m.signed).not.toHaveBeenCalled();
  });
  it("returns not-found for an absent or other-visit photo",async()=>{m.single.mockResolvedValue({data:null,error:null});expect((await get()).status).toBe(404);expect(m.signed).not.toHaveBeenCalled();});
  it("returns to the visit with recovery when signing fails",async()=>{
    m.signed.mockResolvedValue({data:null,error:{message:"denied"}});expect((await get()).headers.get("location")).toBe(`https://app.example.test/admin/visits/${id}?photoError=unavailable`);
  });
});
