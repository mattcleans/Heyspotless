import {beforeEach,describe,it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
const m=vi.hoisted(()=>({profile:vi.fn(),customer:vi.fn(),autopay:vi.fn(),writer:vi.fn(),customerId:vi.fn(),setup:vi.fn(),automatic:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:async()=>({getCurrentProfile:m.profile,getCustomerByProfile:m.customer})}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:m.writer}));
vi.mock("@/lib/billing/store",()=>({BillingStore:class{setAutopay=m.autopay;setStripeCustomerId=vi.fn();}}));
vi.mock("@/lib/billing/gateway",()=>({createSetupSession:m.setup,ensureStripeCustomer:m.customerId}));
vi.mock("@/lib/stripe/env",()=>({isBillingEnabled:()=>true,isAutochargeEnabled:m.automatic}));
import {POST} from "./route";
const call=(body:unknown)=>POST(new NextRequest("https://example.test/api/billing/save-card",{method:"POST",body:JSON.stringify(body)}));
beforeEach(()=>{vi.resetAllMocks();m.profile.mockResolvedValue({id:"client",role:"customer"});m.customer.mockResolvedValue({id:"customer",stripeCustomerId:"cus_synthetic"});m.automatic.mockReturnValue(false);m.customerId.mockResolvedValue("cus_synthetic");m.setup.mockResolvedValue({url:"https://example.test/SYNTHETIC"});});
describe("card saving while automatic payments are paused",()=>{
 it("refuses new automatic-payment consent before writes/provider calls",async()=>{expect((await call({autopay:true})).status).toBe(409);expect(m.writer).not.toHaveBeenCalled();expect(m.customerId).not.toHaveBeenCalled();});
 it("allows saving a card without modifying prior consent",async()=>{expect((await call({})).status).toBe(200);expect(m.autopay).not.toHaveBeenCalled();expect(m.setup).toHaveBeenCalledOnce();});
 it("still permits explicit withdrawal of consent",async()=>{expect((await call({autopay:false})).status).toBe(200);expect(m.autopay).toHaveBeenCalledWith("customer",false);});
 it.each([null,{id:"office",role:"admin"},{id:"cleaner",role:"cleaner"}])("refuses another role before provider access %j",async profile=>{m.profile.mockResolvedValue(profile);expect((await call({})).ok).toBe(false);expect(m.writer).not.toHaveBeenCalled();expect(m.customerId).not.toHaveBeenCalled();});
});
