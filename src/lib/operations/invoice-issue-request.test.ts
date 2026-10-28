import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock("@/lib/http/fetch-with-timeout",()=>({fetchWithTimeout:m.fetch}));
import {requestInvoiceIssue} from "./invoice-issue-request";
const visit="11111111-1111-4111-8111-111111111111",invoice="22222222-2222-4222-8222-222222222222",due="2026-11-01";
const receipt={issued:true,visitId:visit,invoiceId:invoice,totalCents:19900,dueOn:due,issuedAt:"2026-10-28T16:00:00Z"};
beforeEach(()=>vi.resetAllMocks());
describe("issuance transport",()=>{
 it("submits the exact review once and accepts only its matching receipt",async()=>{m.fetch.mockResolvedValue(Response.json(receipt));expect(await requestInvoiceIssue(visit,invoice,19900,due)).toEqual({confirmed:true,receipt});expect(m.fetch).toHaveBeenCalledExactlyOnceWith(`/api/admin/visits/${visit}/invoice-issue`,expect.objectContaining({method:"POST",body:JSON.stringify({invoiceId:invoice,reviewedTotalCents:19900,dueOn:due,confirmed:true})}));});
 it.each([{}, {...receipt,invoiceId:visit},{...receipt,totalCents:20900},{...receipt,dueOn:"2026-11-02"}])("refuses mismatched/unreadable success %j",async body=>{m.fetch.mockResolvedValue(Response.json(body));expect((await requestInvoiceIssue(visit,invoice,19900,due)).confirmed).toBe(false);expect(m.fetch).toHaveBeenCalledOnce();});
 it("does not retry or expose diagnostics after a network uncertainty",async()=>{m.fetch.mockRejectedValue(new Error("private diagnostics"));const r=await requestInvoiceIssue(visit,invoice,19900,due);expect(r).toMatchObject({confirmed:false,signIn:false});expect(JSON.stringify(r)).not.toContain("private diagnostics");expect(m.fetch).toHaveBeenCalledOnce();});
 it("does not retry a response-body timeout",async()=>{m.fetch.mockResolvedValue({ok:true,json:async()=>{throw new Error("body timed out");}});expect((await requestInvoiceIssue(visit,invoice,19900,due)).confirmed).toBe(false);expect(m.fetch).toHaveBeenCalledOnce();});
 it.each([401,409,503])("offers read recovery on HTTP %s",async status=>{m.fetch.mockResolvedValue(Response.json({code:"review_changed",message:"private diagnostics"},{status}));const r=await requestInvoiceIssue(visit,invoice,19900,due);expect(r).toMatchObject({confirmed:false,signIn:status===401});expect(JSON.stringify(r)).not.toContain("private diagnostics");expect(m.fetch).toHaveBeenCalledOnce();});
});
