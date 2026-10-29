import {describe,it,expect} from "vitest";
import {readIssueReceipt} from "./invoice-issue";
const expected={visitId:"11111111-1111-4111-8111-111111111111",invoiceId:"22222222-2222-4222-8222-222222222222",totalCents:19900,dueOn:"2026-11-01"};
const receipt={...expected,issued:true,issuedAt:"2026-10-28T16:00:00+00:00"};
describe("exact issuance receipt",()=>{
 it("requires the exact saved invoice, visit, amount and due date",()=>expect(readIssueReceipt(receipt,expected)).toEqual(receipt));
 it.each([null,{}, {...receipt,issued:false},{...receipt,invoiceId:expected.visitId},{...receipt,visitId:expected.invoiceId},{...receipt,totalCents:19901},{...receipt,totalCents:"19900"},{...receipt,dueOn:"2026-11-02"},{...receipt,issuedAt:"not-a-date"},{...receipt,issuedAt:"2026-10-28T16:00:00"}])("refuses an uncertain or mismatched acknowledgement %j",r=>expect(readIssueReceipt(r,expected)).toBeNull());
});
