import {describe,it,expect} from "vitest";
import {clientInvoiceGroups} from "./client-invoices";
const invoice=(id:string,status:string,balanceCents:number,voidedAt:Date|null=null)=>({id,status,balanceCents,voidedAt});
describe("Client issued balances",()=>{
 it("does not count an unissued service draft as money owed",()=>{const r=clientInvoiceGroups([invoice("draft","draft",19900),invoice("sent","sent",6000)]);expect(r.outstanding.map(i=>i.id)).toEqual(["sent"]);expect(r.outstanding.reduce((n,i)=>n+i.balanceCents,0)).toBe(6000);expect(r.drafts.map(i=>i.id)).toEqual(["draft"]);});
 it("moves the same bill into the payable group only when issued",()=>{const draft=invoice("same","draft",19900);expect(clientInvoiceGroups([draft]).outstanding).toEqual([]);expect(clientInvoiceGroups([{...draft,status:"sent"}]).outstanding).toEqual([{...draft,status:"sent"}]);});
 it("keeps settled and voided bills out of payable balances",()=>{const r=clientInvoiceGroups([invoice("paid","paid",0),invoice("void","void",19900,new Date()),invoice("overdue","overdue",100)]);expect(r.outstanding.map(i=>i.id)).toEqual(["overdue"]);expect(r.settled.map(i=>i.id)).toEqual(["paid","void"]);});
 it("does not turn a zero-value draft into paid history",()=>{const r=clientInvoiceGroups([invoice("draft","draft",0)]);expect(r.settled).toEqual([]);expect(r.drafts).toHaveLength(1);});
});
