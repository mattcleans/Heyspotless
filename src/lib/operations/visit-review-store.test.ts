import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listUninvoicedVisits, loadVisitFacts } from "./visit-review-store";
const rooms={bedrooms:0,bathrooms:0,kitchens:1,livingRooms:0,utilityRooms:0};
type Result={data:unknown;error:unknown};
const ok=(data:unknown):Result=>({data,error:null});
const factsResults=()=>[ok({started_at:null,completed_at:null,invoiced_at:null}),ok([]),ok([]),ok([]),ok([])];
function client(results:Result[]) {
  const queries:Record<string,ReturnType<typeof vi.fn>>[]=[];
  const tables:string[]=[];
  const from=vi.fn((table:string)=>{
    tables.push(table); const result=results.shift()??ok([]);
    const query:Record<string,ReturnType<typeof vi.fn>>={};
    for(const name of ["select","eq","is","in","order","limit"])query[name]=vi.fn().mockReturnValue(query);
    query.maybeSingle=vi.fn().mockResolvedValue(result);
    query.then=vi.fn((resolve)=>(Promise.resolve(result).then(resolve)));
    queries.push(query);return query;
  });
  return{db:{from} as unknown as SupabaseClient,queries,tables,from};
}
describe("request-scoped executive review reads",()=>{
  it("limits the queue to completed visits without an invoice timestamp in deterministic oldest-first order",async()=>{
    const {db,queries}=client([ok([])]);expect(await listUninvoicedVisits(db)).toEqual([]);
    const q=queries[0]!;expect(q.eq).toHaveBeenCalledWith("status","complete");expect(q.is).toHaveBeenCalledWith("invoiced_at",null);
    expect(q.order).toHaveBeenCalledWith("completed_at",{ascending:true,nullsFirst:true});expect(q.order).toHaveBeenCalledWith("id",{ascending:true});expect(q.limit).toHaveBeenCalledWith(200);
  });
  it.each([{data:null,error:null},{data:[],error:{message:"denied"}}])("does not turn unreadable queue data into no exceptions",async result=>{
    const {db}=client([result]);await expect(listUninvoicedVisits(db)).rejects.toThrow("Unable to load");
  });
  it("scopes every detail read to this visit and bounds required evidence by its actual room keys",async()=>{
    const {db,queries,tables}=client(factsResults());await loadVisitFacts(db,"visit",rooms);
    expect(tables).toEqual(["jobs","job_photos","job_photos","job_assignments","invoices"]);
    expect(queries[0]!.eq).toHaveBeenCalledWith("id","visit");
    for(const q of queries.slice(1))expect(q.eq).toHaveBeenCalledWith("job_id","visit");
    expect(queries[1]!.in).toHaveBeenCalledWith("room_key",["kitchen_1"]);expect(queries[1]!.in).toHaveBeenCalledWith("kind",["before","after"]);
    expect(queries[1]!.limit).toHaveBeenCalledWith(2);expect(queries[2]!.limit).toHaveBeenCalledWith(20);
    expect(queries[1]!.select).not.toHaveBeenCalledWith(expect.stringContaining("storage_path"));
  });
  it.each([0,1,2,3,4])("fails visibly when read %s is denied",async index=>{
    const results=factsResults();results[index]={data:null,error:{message:"denied"}};
    const {db}=client(results);await expect(loadVisitFacts(db,"visit",rooms)).rejects.toThrow();
  });
  it("handles nullable assignment profiles and recorded invoice amounts without treating balance as revenue",async()=>{
    const results=factsResults();results[3]=ok([{cleaners:{id:"c",full_name:"Cleaner",profiles:null}}]);
    results[4]=ok([{id:"i",status:"draft",total_cents:"10000",balance_cents:9000}]);
    const {db}=client(results);const facts=await loadVisitFacts(db,"visit",rooms);
    expect(facts.assignments[0]?.phone).toBeNull();expect(facts.invoices[0]).toMatchObject({totalCents:10000,balanceCents:9000});
  });
  it.each([null,"", " ","bad",1.5])("rejects unverifiable money %j rather than showing zero",async amount=>{
    const results=factsResults();results[4]=ok([{id:"i",status:"draft",total_cents:amount,balance_cents:0}]);
    const {db}=client(results);await expect(loadVisitFacts(db,"visit",rooms)).rejects.toThrow("amounts");
  });
  it("rejects malformed dates rather than dropping a recorded completion",async()=>{
    const results=factsResults();results[0]=ok({started_at:null,completed_at:"invalid",invoiced_at:null});
    const {db}=client(results);await expect(loadVisitFacts(db,"visit",rooms)).rejects.toThrow("timing");
  });
  it("does not read unscoped records when a visit identity is absent",async()=>{
    const {db,from}=client([]);await expect(loadVisitFacts(db,"",rooms)).rejects.toThrow("identity");expect(from).not.toHaveBeenCalled();
  });
});
