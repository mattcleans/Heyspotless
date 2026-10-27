import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ profile: vi.fn(), cleaner: vi.fn(), contacts: vi.fn(), claim: vi.fn(), receipt: vi.fn(), settle: vi.fn(), send: vi.fn(), enabled: vi.fn(), approval: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile, getCleanerByProfile: m.cleaner }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({ limit: m.approval }) }) }) }) }));
vi.mock("@/lib/automations/store", () => ({ AutomationStore: class { contactsFor = m.contacts; } }));
vi.mock("@/lib/messaging/store", () => ({ ON_MY_WAY: "visit.on_my_way", MessagingStore: class { claimByKey = m.claim; onMyWayReceipt = m.receipt; settle = m.settle; } }));
vi.mock("@/lib/messaging/gateway", () => ({ sendSms: m.send }));
vi.mock("@/lib/messaging/env", () => ({ isMessagingEnabled: m.enabled }));
import { POST, GET } from "./route";
import { arrivalTextReceipt } from "@/lib/messaging/arrival-receipt";
const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = () => new NextRequest("https://example.test/api/jobs/on-my-way", { method: "POST", body: JSON.stringify({ jobId }) });
beforeEach(() => {
  vi.resetAllMocks();m.profile.mockResolvedValue({ id: "profile", role: "cleaner" });m.cleaner.mockResolvedValue({ id: "cleaner", name: "Synthetic Cleaner" });
  m.contacts.mockResolvedValue(new Map([[jobId, { cleanerId: "cleaner", status: "assigned", customerId: "customer", customerPhone: "+15005550006", customerFirstName: "Synthetic" }]]));
  m.enabled.mockReturnValue(true);m.approval.mockResolvedValue({ data: [], error: null });m.claim.mockResolvedValue("message");
  m.receipt.mockResolvedValue(arrivalTextReceipt(null));m.send.mockResolvedValue({ok:true,providerId:"SM_SYNTHETIC"});
});
describe("On my way receipts", () => {
  it.each(["failed", null])("never calls a previous request sent when its failure is %s and no provider receipt exists", async failedReason => {
    m.receipt.mockResolvedValue(arrivalTextReceipt({ providerId:null,failedReason }));
    const result = await (await POST(request())).json();
    expect(result.sent).not.toBe(true);expect(result.state).toBe("unconfirmed");expect(m.send).not.toHaveBeenCalled();
  });
  it("does not send twice when another tab claimed the key before this tab", async () => {
    m.claim.mockResolvedValue(null);
    const result=await (await POST(request())).json();
    expect(result.state).toBe("unconfirmed");expect(m.send).not.toHaveBeenCalled();
  });
  it("checks an accepted receipt after reload without contacting the provider", async () => {
    m.receipt.mockResolvedValue(arrivalTextReceipt({providerId:"SM_SYNTHETIC",failedReason:null}));
    const response=await GET(new NextRequest(`https://example.test/api/jobs/on-my-way?jobId=${jobId}`));
    expect(await response.json()).toMatchObject({state:"accepted",message:expect.stringContaining("has not been confirmed")});
    expect(response.headers.get("cache-control")).toContain("no-store");expect(m.send).not.toHaveBeenCalled();expect(m.claim).not.toHaveBeenCalled();
  });
  it("records provider acceptance without claiming carrier delivery", async () => {
    expect(await (await POST(request())).json()).toMatchObject({state:"accepted",message:expect.stringContaining("Delivery to the Client has not been confirmed")});
    expect(m.send).toHaveBeenCalledOnce();expect(m.settle).toHaveBeenCalledWith("message","SM_SYNTHETIC");
  });
  it("keeps an uncertain send held and hides raw provider diagnostics", async () => {
    m.send.mockResolvedValue({ok:false,reason:"private provider diagnostic",retryable:true});
    const response=await POST(request());expect(response.status).toBe(502);
    const text=await response.text();expect(text).toContain("unconfirmed");expect(text).not.toContain("private provider diagnostic");
    expect(m.settle).toHaveBeenCalledWith("message",null,"private provider diagnostic");
  });
  it("does not accept an empty provider receipt as a submitted text", async () => {
    m.send.mockResolvedValue({ok:true,providerId:""});
    expect(await (await POST(request())).json()).toMatchObject({state:"unconfirmed",sent:false});
  });
  it.each([null,{role:"admin",id:"admin"},{role:"customer",id:"customer"}])("denies receipt reads to %j",async profile=>{
    m.profile.mockResolvedValue(profile);const response=await GET(new NextRequest(`https://example.test/api/jobs/on-my-way?jobId=${jobId}`));
    expect(response.status).toBe(profile?403:401);expect(m.contacts).not.toHaveBeenCalled();expect(m.receipt).not.toHaveBeenCalled();
  });
  it("denies the previous Cleaner after reassignment",async()=>{
    m.contacts.mockResolvedValue(new Map([[jobId,{cleanerId:"replacement"}]]));
    expect((await POST(request())).status).toBe(409);expect(m.claim).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
  it.each([{data:[{approved:false,unambiguous:true}],error:null},{data:null,error:{message:"unavailable"}}])("does not request an arrival text without confirmed approval %j",async approval=>{
    m.approval.mockResolvedValue(approval);expect((await POST(request())).ok).toBe(false);
    expect(m.claim).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
  it("does not create a request while messaging is inactive",async()=>{
    m.enabled.mockReturnValue(false);expect(await (await POST(request())).json()).toMatchObject({state:"unavailable",sent:false});
    expect(m.claim).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
});
