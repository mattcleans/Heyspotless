import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m=vi.hoisted(()=>({repo:vi.fn(),client:vi.fn(),queue:vi.fn(),facts:vi.fn(),job:vi.fn(),home:vi.fn(),jobs:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:m.repo}));vi.mock("@/lib/supabase/server",()=>({createClient:m.client}));
vi.mock("@/lib/operations/visit-review-store",()=>({listUninvoicedVisits:m.queue,loadVisitFacts:m.facts}));
vi.mock("next/navigation",()=>({notFound:()=>{throw new Error("not-found");},useRouter:()=>({refresh:vi.fn()})}));
import ReviewPage from "./page";
import DetailPage from "../visits/[id]/page";
const id="95000000-0000-0000-0000-000000000001";
const job={id,customerId:"customer",propertyId:"home",customerName:"Sample Client",street:"Sample street",city:"Dallas",status:"complete",scheduledStart:null};
const rooms={bedrooms:0,bathrooms:0,kitchens:1,livingRooms:0,utilityRooms:0};
const facts={startedAt:null,completedAt:null,invoicedAt:null,photos:[],issues:[],assignments:[],invoices:[]};
function account(role:string|null,demo=false){m.repo.mockResolvedValue({isDemo:demo,getCurrentProfile:async()=>role?{role}:null,getJob:m.job,getProperty:m.home,getCustomer:async()=>({phone:null}),listJobs:m.jobs});}
const detail=(visitId=id,photoError?:string)=>DetailPage({params:Promise.resolve({id:visitId}),searchParams:Promise.resolve({photoError})});
beforeEach(()=>{vi.clearAllMocks();account("admin");m.job.mockResolvedValue(job);m.home.mockResolvedValue({street:"Sample street",city:"Dallas",rooms});m.facts.mockResolvedValue(facts);m.queue.mockResolvedValue([]);m.jobs.mockResolvedValue([job]);m.client.mockResolvedValue({});});
describe("management review screens",()=>{
  it.each([null,"cleaner","customer"])("does not read management data for %s",async role=>{
    account(role);expect(renderToStaticMarkup(await ReviewPage())).toContain("management account");expect(renderToStaticMarkup(await detail())).toContain("management account");
    expect(m.client).not.toHaveBeenCalled();expect(m.job).not.toHaveBeenCalled();expect(m.queue).not.toHaveBeenCalled();expect(m.facts).not.toHaveBeenCalled();
  });
  it("labels an empty invoice-creation check without claiming all visits are paid",async()=>{
    const html=renderToStaticMarkup(await ReviewPage());expect(html).toContain("No uninvoiced completed visits found");expect(html).toContain("does not confirm");expect(html).toContain("200");
  });
  it("links each queue record to its specific visit",async()=>{
    m.queue.mockResolvedValue([{job,completedAt:null}]);const html=renderToStaticMarkup(await ReviewPage());expect(html).toContain(`/admin/visits/${id}`);expect(html).toContain("Completion time not recorded");
  });
  it("rejects malformed live identifiers before reading the visit",async()=>{await expect(detail("not-id")).rejects.toThrow("not-found");expect(m.job).not.toHaveBeenCalled();});
  it("rejects an inaccessible visit",async()=>{m.job.mockResolvedValue(null);await expect(detail()).rejects.toThrow("not-found");expect(m.facts).not.toHaveBeenCalled();});
  it("does not fabricate a zero-room checklist when home data is missing",async()=>{m.home.mockResolvedValue(null);await expect(detail()).rejects.toThrow("Home details");expect(m.facts).not.toHaveBeenCalled();});
  it("shows server photo gaps and the cleaner's recovery action",async()=>{
    const html=renderToStaticMarkup(await detail());expect(html).toContain("2 required photos outstanding");expect(html).toContain("reopen this visit");expect(html).toContain("Not received");expect(html).not.toContain("createSignedUrl");
  });
  it("keeps recorded invoice status and balance separate from missing photos",async()=>{
    m.facts.mockResolvedValue({...facts,invoices:[{id:"invoice",status:"draft",totalCents:10000,balanceCents:10000}]});
    const html=renderToStaticMarkup(await detail());expect(html).toContain("Invoice recorded");expect(html).toContain("Recorded balance $100.00");expect(html).toContain("2 required photos outstanding");
  });
  it("links photos through the protected visit/photo route rather than embedding private storage paths",async()=>{
    m.facts.mockResolvedValue({...facts,photos:[{id:"photo",roomKey:"kitchen_1",kind:"before",takenAt:new Date()}]});
    const html=renderToStaticMarkup(await detail());expect(html).toContain(`/api/admin/visits/${id}/photos/photo`);expect(html).not.toContain("storage_path");expect(html).toContain("opens in a new tab");
  });
  it("shows actionable recovery when a photo could not be opened",async()=>{expect(renderToStaticMarkup(await detail(id,"unavailable"))).toContain("That photo could not be opened");});
  it("supports sample review links without live queries or photo access",async()=>{
    account(null,true);const html=renderToStaticMarkup(await ReviewPage());expect(html).toContain("review-sample-invoice");
    const detailHtml=renderToStaticMarkup(await detail("review-sample-invoice"));expect(detailHtml).toContain("Ready for invoice review");expect(detailHtml).toContain("Sample record");expect(m.client).not.toHaveBeenCalled();
  });
});
