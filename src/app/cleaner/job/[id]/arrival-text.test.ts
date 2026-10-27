import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { arrivalTextReceipt, unconfirmedArrivalText } from "@/lib/messaging/arrival-receipt";
import { ArrivalTextStatus } from "./arrival-text-controls";
import { requestArrivalText } from "./arrival-text-request";
import { CLIENT_REQUEST_TIMEOUT_MS } from "@/lib/http/fetch-with-timeout";
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe("truthful arrival status",()=>{
  it("never treats a pending, failed or empty receipt as accepted",()=>{
    for(const row of [{providerId:null,failedReason:null},{providerId:null,failedReason:"timeout"},{providerId:"",failedReason:null},{providerId:"SM_SYNTHETIC",failedReason:"failed"}])expect(arrivalTextReceipt(row).state).toBe("unconfirmed");
    expect(arrivalTextReceipt(null).state).toBe("not_requested");
  });
  it("replaces the delivery promise with provider acceptance",()=>{
    const html=renderToStaticMarkup(createElement(ArrivalTextStatus,{receipt:arrivalTextReceipt({providerId:"SM_SYNTHETIC",failedReason:null}),working:false,jobId:"job",onAction:()=>{}}));
    expect(html).toContain("Text submitted");expect(html).toContain("has not been confirmed");expect(html).toContain('disabled=""');expect(html).not.toContain("know you");
  });
  it("offers a status check and office help for uncertainty",()=>{
    const html=renderToStaticMarkup(createElement(ArrivalTextStatus,{receipt:unconfirmedArrivalText(),working:false,jobId:"job",onAction:()=>{}}));
    expect(html).toContain("Check text status");expect(html).toContain('href="tel:+14692800397"');expect(html).toContain("min-h-11");expect(html).not.toContain("On my way");
  });
  it("recovers a lost POST response through a separate read, without retrying a send",async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(Response.json(arrivalTextReceipt({providerId:"SM_SYNTHETIC",failedReason:null})));
    vi.stubGlobal("fetch",fetch);
    expect((await requestArrivalText("job","POST")).state).toBe("unconfirmed");
    expect(fetch).toHaveBeenCalledOnce();
    expect((await requestArrivalText("job","GET")).state).toBe("accepted");
    expect(fetch.mock.calls.map(c=>c[1].method)).toEqual(["POST","GET"]);
  });
  it("does not trust the legacy sent flag without a current receipt state",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({sent:true,already:true})));
    expect((await requestArrivalText("job","POST")).state).toBe("unconfirmed");
  });
  it("bounds a stalled receipt body without claiming the Client was not told",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(_path,init)=>({ok:true,json:()=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true}))})));
    const result=requestArrivalText("job","POST");await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
    expect(await result).toMatchObject({state:"unconfirmed"});
  });
});
