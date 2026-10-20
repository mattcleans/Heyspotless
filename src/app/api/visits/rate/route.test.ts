import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), admin: vi.fn(), rpc: vi.fn(), billing: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: m.billing }));
import { POST } from "./route";
const jobId = "e1500000-0000-4000-8000-000000000001";
const actor = "e1100000-0000-4000-8000-000000000001";
const requestId = "e1600000-0000-4000-8000-000000000001";
const submit = (body: Record<string, unknown> = {}) => POST(new NextRequest("https://example.test/api/visits/rate", {
  method: "POST", body: JSON.stringify({ jobId, requestId, score: 5, tipCents: 0, ...body }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  m.repo.mockResolvedValue({ getCurrentProfile: async () => ({ id: actor, role: "customer" }) });
  m.admin.mockReturnValue({ rpc: m.rpc });
  m.rpc.mockImplementation(async (_name, args) => ({ data: {
    recorded: true, tip: args.p_tip_cents ? { tipCents: args.p_tip_cents, feeCents: 115, netCents: 3865 } : null,
  }, error: null }));
  m.billing.mockReturnValue(true);
});
describe("atomic rating and tip outcomes", () => {
  it("saves a rating with one owned transaction while billing is disabled", async () => {
    m.billing.mockReturnValue(false);
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true, tip: null });
    expect(m.rpc).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenCalledWith("record_client_visit_feedback_once",expect.objectContaining({p_submission_id:requestId,p_profile_id:actor,p_job_id:jobId,p_tip_cents:0}));
  });
  it("cannot accept an actor supplied by the request", async () => {
    await submit({ profileId: "another actor", p_profile_id: "another actor" });
    expect(m.rpc.mock.calls[0]![1].p_profile_id).toBe(actor);
  });
  it("asks an old form to refresh before any write when its submission identity is missing",async()=>{
    const response=await submit({requestId:undefined});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:expect.stringContaining("Refresh")});
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("refuses tip writes while billing is disabled but keeps the rating", async () => {
    m.billing.mockReturnValue(false);
    const response = await submit({ tipCents: 3980 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ recorded: true, tip: null, error: expect.stringContaining("no tip was added") });
    expect(m.rpc.mock.calls[0]![1].p_tip_cents).toBe(0);
  });
  it.each(["tip_no_invoice","tip_invoice_review","tip_assignment_review","tip_payment_in_progress","tip_above_price","tip_unavailable"])("keeps the rating and reports %s without claiming a tip",async tipError=>{
    m.rpc.mockResolvedValue({data:{recorded:true,tip:null,tipError},error:null});
    const response=await submit({tipCents:3980});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({recorded:true,tip:null,error:expect.stringContaining("Your rating was saved")});
    expect(m.rpc).toHaveBeenCalledOnce();
  });
  it("returns the actual reconciled invoice/payout split", async () => {
    const response = await submit({ tipCents: 3980 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true, tip: { tipCents: 3980, feeCents: 115, netCents: 3865 } });
    expect(m.rpc).toHaveBeenCalledOnce();
  });
  it("does not invent a confirmed tip from a malformed receipt",async()=>{
    m.rpc.mockResolvedValue({data:{recorded:true,tip:{tipCents:3980,feeCents:115,netCents:4000}},error:null});
    const response=await submit({tipCents:3980});
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({recorded:true,tip:null,error:expect.stringContaining("Check Account")});
  });
  it("refuses an ownership or completion change detected by the locked transaction",async()=>{
    m.rpc.mockResolvedValue({data:{recorded:false},error:null});
    const response=await submit({tipCents:3980});
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("recorded",true);
  });
  it.each([{score:0},{score:6},{score:2.5},{score:"5"},{jobId:"job"},{tipCents:-1},{tipCents:1.5},{tipCents:"500"},{tipCents:2147483648}])("refuses malformed input %j before writing",async body=>{
    expect((await submit(body)).status).toBe(400);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("deduplicates allowed highlights and bounds private notes",async()=>{
    await submit({highlights:["thorough","thorough","not_allowed",9],privateNote:"  "+"x".repeat(2100)+"  "});
    expect(m.rpc.mock.calls[0]![1].p_highlights).toEqual(["thorough"]);
    expect(m.rpc.mock.calls[0]![1].p_private_note).toHaveLength(2000);
  });
  it("does not claim a saved rating when its transaction fails",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    m.rpc.mockResolvedValue({data:null,error:{code:"unavailable"}});
    const response=await submit();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("recorded",true);
    vi.restoreAllMocks();
  });
  it.each([null,{id:actor,role:"cleaner"},{id:actor,role:"admin"}])("refuses an absent or non-Client session %j",async profile=>{
    m.repo.mockResolvedValue({getCurrentProfile:async()=>profile});
    expect((await submit()).status).toBe(profile?403:401);
    expect(m.admin).not.toHaveBeenCalled();
  });
});
