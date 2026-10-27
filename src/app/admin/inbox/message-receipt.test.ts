import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({profile:vi.fn(),client:vi.fn(),load:vi.fn()}));
vi.mock("@/lib/data",()=>({getRepository:async()=>({getCurrentProfile:m.profile})}));
vi.mock("@/lib/supabase/server",()=>({createClient:m.client}));
vi.mock("@/lib/supabase/env",()=>({isDemoMode:()=>false}));
vi.mock("@/lib/messaging/inbox",()=>({loadInbox:m.load}));
vi.mock("next/navigation",()=>({notFound:()=>{throw new Error("not_found");},useRouter:()=>({refresh:vi.fn()})}));
import { MessageReceipt } from "./message-receipt";
import Page from "./page";
beforeEach(()=>vi.resetAllMocks());
describe("office message receipt",()=>{
  it.each([null,"timeout"])("flags an unconfirmed request with recorded error %s",failedReason=>{
    const html=renderToStaticMarkup(createElement(MessageReceipt,{message:{channel:"sms",direction:"outbound",providerId:null,failedReason}}));
    expect(html).toContain("Delivery unconfirmed · needs review");expect(html).toContain("before sending another message");expect(html).toContain("Not saved");
  });
  it("does not convert provider acceptance into delivery",()=>{
    const html=renderToStaticMarkup(createElement(MessageReceipt,{message:{channel:"sms",direction:"outbound",providerId:"SM_SYNTHETIC",failedReason:null}}));
    expect(html).toContain("Submitted · delivery unconfirmed");expect(html).toContain("SM_SYNTHETIC");expect(html).not.toContain("Delivered");
  });
  it.each(["email","in_app"] as const)("does not apply SMS state to %s records",channel=>{
    expect(renderToStaticMarkup(createElement(MessageReceipt,{message:{channel,direction:"outbound"}}))).toBe("");
  });
  it("does not apply outgoing state to incoming texts",()=>{
    expect(renderToStaticMarkup(createElement(MessageReceipt,{message:{channel:"sms",direction:"inbound"}}))).toBe("");
  });
  it.each([null,{role:"customer"},{role:"cleaner"}])("refuses receipt details to %j before reading messages",async profile=>{
    m.profile.mockResolvedValue(profile);await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow("not_found");expect(m.client).not.toHaveBeenCalled();expect(m.load).not.toHaveBeenCalled();
  });
});
