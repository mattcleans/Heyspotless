import { describe,expect,it } from "vitest";
import { readChangeFeeReceipt } from "./change-fee";
const expected={visitId:"fa500000-0000-4000-8000-000000000001",invoiceId:"fa600000-0000-4000-8000-000000000001",changeId:"fa700000-0000-4000-8000-000000000001",kind:"cancellation_fee" as const,totalCents:6000,dueOn:"2026-10-30"};
const receipt={...expected,issued:true,issuedAt:"2026-10-29T22:00:00Z"};
describe("exact fee issuance confirmation",()=>{
 it("accepts only the reviewed invoice, visit, saved change, kind, amount and due date",()=>expect(readChangeFeeReceipt(receipt,expected)).toEqual(receipt));
 it.each([{invoiceId:"fa600000-0000-4000-8000-000000000002"},{changeId:"fa700000-0000-4000-8000-000000000002"},{kind:"reschedule_fee"},{totalCents:0},{dueOn:"2026-10-31"},{issuedAt:"invalid"},{issued:false},{visitId:"fa500000-0000-4000-8000-000000000002"}])("does not confirm a mismatched reply %j",change=>expect(readChangeFeeReceipt({...receipt,...change},expected)).toBeNull());
 it("requires a saved change identity rather than just an issued service receipt",()=>expect(readChangeFeeReceipt({...receipt,changeId:undefined,kind:undefined},expected)).toBeNull());
});
