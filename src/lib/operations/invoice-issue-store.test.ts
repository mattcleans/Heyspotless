import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {issueServiceInvoice,InvoiceReviewChanged} from "./invoice-issue-store";
const visit="11111111-1111-4111-8111-111111111111",invoice="22222222-2222-4222-8222-222222222222";
const data={issued:true,visitId:visit,invoiceId:invoice,totalCents:19900,dueOn:"2026-11-01",issuedAt:"2026-10-28T16:00:00Z"};
const client=(result:unknown)=>({rpc:vi.fn().mockResolvedValue(result)}) as unknown as SupabaseClient;
describe("reviewed issuance store",()=>{
 it("passes the authenticated office actor and exact review to one guarded routine",async()=>{const db=client({data,error:null});expect(await issueServiceInvoice(db,visit,invoice,"actor",19900,"2026-11-01")).toEqual(data);expect(db.rpc).toHaveBeenCalledWith("issue_reviewed_service_invoice",{p_job:visit,p_invoice:invoice,p_actor:"actor",p_reviewed_total:19900,p_due:"2026-11-01"});});
 it("classifies a stale review distinctly",async()=>{await expect(issueServiceInvoice(client({data:null,error:{code:"PIS01"}}),visit,invoice,"actor",19900,"2026-11-01")).rejects.toBeInstanceOf(InvoiceReviewChanged);});
 it.each([{data:null,error:null},{data:{...data,totalCents:1},error:null},{data:null,error:{code:"XX000",message:"private diagnostics"}}])("never confirms an unreadable receipt or leaks diagnostics",async r=>{await expect(issueServiceInvoice(client(r),visit,invoice,"actor",19900,"2026-11-01")).rejects.toThrow("Invoice issuance could not be confirmed.");});
});
