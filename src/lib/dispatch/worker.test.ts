import { beforeEach, describe, expect, it, vi } from "vitest";
// The actual Edge HTTP boundary is plain JavaScript so both runtimes test it.
// @ts-expect-error The deployment JavaScript is checked by Deno in CI.
import { createWorkerHandler, workerToken } from "../../../supabase/functions/matching-worker/handler.js";
const config={projectRef:"abcdefghijklmnopqrst",appOrigin:"https://preview.example.test",sourceVersion:"a".repeat(40),sourceDigest:"b".repeat(64),preview:true};
const service="test-worker-service-key",env=(key:string)=>key==="SUPABASE_SERVICE_ROLE_KEY"?service:key==="SUPABASE_URL"?"https://abcdefghijklmnopqrst.supabase.co":null;
const summary={jobs:1,expiredOffers:0,assigned:0,needsScheduling:0,held:0,offered:1,notified:0,deferred:0,unreachable:0,refused:0,unfilled:0,pushed:0,failed:0};
const m={run:vi.fn(),claim:vi.fn(),finish:vi.fn()};
const handler=(getEnv=env)=>createWorkerHandler({config,getEnv,...m});
async function request(method="POST",token?:string){return new Request("https://functions.example.test/matching-worker",{method,headers:token?{"x-heyspotless-worker-token":token}:{}});}
beforeEach(()=>{vi.clearAllMocks();m.run.mockResolvedValue(summary);m.claim.mockResolvedValue(true);m.finish.mockResolvedValue(true);});
describe("matching worker boundary",()=>{
 it("denies a public key or ordinary account without the scoped token",async()=>{expect((await handler()(await request())).status).toBe(401);expect(m.claim).not.toHaveBeenCalled();expect(m.run).not.toHaveBeenCalled();});
 it("binds the scoped token to one project rather than reusing the service key",async()=>{const token=await workerToken(service,config.projectRef);expect(token).not.toBe(service);expect(token).not.toBe(await workerToken(service,"other-project"));expect((await handler()(await request("POST",service))).status).toBe(401);});
 it("reports authenticated startup without claiming a database health pass",async()=>{const r=await handler()(await request("GET",await workerToken(service,config.projectRef)));expect(r.status).toBe(200);expect(await r.json()).toMatchObject({databaseChecked:false,providerMessagesAllowed:false,sourceVersion:config.sourceVersion});expect(m.claim).not.toHaveBeenCalled();});
 it("refuses mismatched project configuration before touching a lease",async()=>{const getEnv=(key:string)=>key==="SUPABASE_URL"?"https://different.supabase.co":env(key);expect((await handler(getEnv)(await request("POST",await workerToken(service,config.projectRef)))).status).toBe(503);expect(m.claim).not.toHaveBeenCalled();});
 it("skips an overlapping run without claiming successful work",async()=>{m.claim.mockResolvedValue(false);const r=await handler()(await request("POST",await workerToken(service,config.projectRef)));expect(r.status).toBe(202);expect(m.run).not.toHaveBeenCalled();expect(m.finish).not.toHaveBeenCalled();});
 it("records only numeric matching results under the same lease",async()=>{const r=await handler()(await request("POST",await workerToken(service,config.projectRef)));expect(r.status).toBe(200);expect(m.run).toHaveBeenCalledWith(config.appOrigin);expect(m.finish).toHaveBeenCalledWith(expect.any(String),"success",summary);});
 it("marks partial matching failures as failures for the scheduler",async()=>{m.run.mockResolvedValue({...summary,failed:1,problems:[{error:"private detail"}]});const r=await handler()(await request("POST",await workerToken(service,config.projectRef)));expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain("private detail");expect(m.finish).toHaveBeenCalledWith(expect.any(String),"failed",{...summary,failed:1});});
 it("cannot overwrite a newer lease or claim a late result as successful",async()=>{m.finish.mockResolvedValue(false);expect((await handler()(await request("POST",await workerToken(service,config.projectRef)))).status).toBe(503);});
 it("retains retry guidance when the matcher or result becomes unusable",async()=>{m.run.mockRejectedValue(new Error("private detail"));const r=await handler()(await request("POST",await workerToken(service,config.projectRef)));expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain("private detail");expect(m.finish).toHaveBeenCalledWith(expect.any(String),"failed",{});});
});
