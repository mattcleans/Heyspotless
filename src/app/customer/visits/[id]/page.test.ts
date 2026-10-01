import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
const m=vi.hoisted(()=>({repo:vi.fn(),client:vi.fn(),visit:vi.fn(),cleaner:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:m.repo}));
vi.mock("@/lib/supabase/server",()=>({createClient:m.client}));
vi.mock("@/lib/visits/customer-visit-store",()=>({loadCustomerVisit:m.visit}));
vi.mock("@/lib/cleaners/store",()=>({CleanerDirectory:class{get=m.cleaner;}}));
vi.mock("next/navigation",()=>({notFound:()=>{throw new Error("not-found");},useRouter:()=>({refresh:vi.fn()})}));
import VisitPage from "./page";
import { CustomerVisitDetails } from "@/components/customer-visit-details";
import type { CustomerVisit } from "@/lib/visits/customer-visit-store";
const id="96000000-0000-0000-0000-000000000001";
const summary={stage:"cleaning" as const,scheduledStart:new Date("2026-10-01T14:00:00Z"),startedAt:new Date("2026-10-01T14:04:00Z"),completedAt:null,expectedFinishAt:new Date("2026-10-01T15:34:00Z"),roomsDone:1,roomsTotal:2};
const details:CustomerVisit={summary,address:"Sample St, Dallas 75001",propertyId:"home",cleanerId:"cleaner",rooms:[{key:"kitchen_1",label:"Kitchen",recorded:true},{key:"half_bath_1",label:"Half bath",recorded:false}]};
const page=(visitId=id)=>VisitPage({params:Promise.resolve({id:visitId})});
const render=(over:Partial<CustomerVisit["summary"]>={})=>renderToStaticMarkup(createElement(CustomerVisitDetails,{id,details:{...details,summary:{...summary,...over}},cleaner:null,now:new Date("2026-10-01T16:00:00Z")}));
beforeEach(()=>{vi.clearAllMocks();m.repo.mockResolvedValue({isDemo:false,getCurrentProfile:async()=>({role:"customer"})});m.client.mockResolvedValue({});m.visit.mockResolvedValue(details);m.cleaner.mockResolvedValue(null);});
describe("client visit detail",()=>{
  it.each([null,"cleaner"])("does not read visit data for %s",async role=>{
    m.repo.mockResolvedValue({isDemo:false,getCurrentProfile:async()=>role?{role}:null});const html=renderToStaticMarkup(await page());
    expect(html).toContain("Sign in to see your visit");expect(m.visit).not.toHaveBeenCalled();expect(m.client).not.toHaveBeenCalled();
  });
  it("rejects malformed IDs before visit reads",async()=>{await expect(page("------------------------------------")).rejects.toThrow("not-found");expect(m.visit).not.toHaveBeenCalled();});
  it("rejects inaccessible visits without reading cleaner profiles",async()=>{m.visit.mockResolvedValue(null);await expect(page()).rejects.toThrow("not-found");expect(m.cleaner).not.toHaveBeenCalled();});
  it("reads the named cleaner through the public profile directory",async()=>{await page();expect(m.cleaner).toHaveBeenCalledWith("cleaner");});
  it("shows the specific home, actual photo evidence and a link to its instructions",()=>{
    const html=render();expect(html).toContain("Sample St, Dallas 75001");expect(html).toContain("1 of 2 rooms have before-and-after photos recorded");
    expect(html).toContain("Awaiting photo updates");expect(html).toContain("Missing photos do not tell us that a room is unfinished");expect(html).toContain('/customer/account/homes/home');expect(html).toContain('aria-current="step"');
  });
  it("keeps completed work separate from missing photo evidence and still supports refresh/rating",()=>{
    const html=render({stage:"done",completedAt:new Date("2026-10-01T16:00:00Z")});expect(html).toContain("Your cleaner has finished");
    expect(html).toContain("1 of 2 rooms");expect(html).toContain("Photos may still be waiting");expect(html).toContain("Refresh visit");expect(html).toContain(`/customer/visits/${id}/rate`);
    expect(html).not.toContain("Estimated finish");expect(html).not.toContain("Review home instructions");
  });
  it("shows canceled recovery without a progress tracker, rate action, ETA or active cleaner promise",async()=>{
    m.visit.mockResolvedValue({...details,summary:{...summary,stage:"canceled"}});const html=renderToStaticMarkup(await page());
    expect(html).toContain("This visit was canceled");expect(html).toContain("Original appointment");expect(html).toContain("Request a clean");expect(html).toContain("needs confirmation");
    expect(html).not.toContain('aria-label="Visit progress"');expect(html).not.toContain("Rate this clean");expect(html).not.toContain("Estimated finish");expect(m.cleaner).not.toHaveBeenCalled();
  });
  it("labels elapsed estimates without reporting completion",()=>{const html=render();expect(html).toContain("estimated finish time has passed");expect(html).toContain("still marked in progress");});
  it("labels future finish estimates as changeable",()=>{expect(render({expectedFinishAt:new Date("2026-10-01T17:00:00Z")})).toContain("It can change as work continues");});
  it("does not invent an estimate when no start was recorded",()=>{expect(render({startedAt:null,expectedFinishAt:null})).not.toContain("Estimated finish");});
  it("does not fabricate room completion for a zero-room home",()=>{
    const html=render({roomsDone:0,roomsTotal:0});expect(html).toContain("no configured rooms");expect(html).not.toContain("0 of 0");
  });
  it("distinguishes an unavailable assigned profile from no match yet",()=>{
    expect(render({stage:"accepted"})).toContain("Cleaner profile details are unavailable");expect(render({stage:"scheduled"})).toContain("once matched");
  });
});
