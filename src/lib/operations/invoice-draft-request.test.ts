import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/http/fetch-with-timeout", () => ({ fetchWithTimeout: vi.fn() }));
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { requestServiceDraft } from "./invoice-draft-request";
const fetcher = vi.mocked(fetchWithTimeout);
const visitId = "f1000000-0000-4000-8000-000000000001";
const valid = { confirmed: true, visitId, invoiceId: "f2000000-0000-4000-8000-000000000001", status: "draft", totalCents: 19900 };
afterEach(() => vi.resetAllMocks());
describe("draft receipt recovery", () => {
  it("confirms a bound saved receipt", async () => { fetcher.mockResolvedValue(Response.json(valid)); expect(await requestServiceDraft(visitId, 19900)).toMatchObject({ confirmed: true, totalCents: 19900 }); expect(fetcher).toHaveBeenCalledTimes(1); });
  it.each([{ ...valid, visitId: "other" }, { ...valid, invoiceId: "" }, { ...valid, status: "void" }, { ...valid, totalCents: -1 }, { confirmed: true }])("holds unverified response %j for refresh", async data => { fetcher.mockResolvedValue(Response.json(data)); expect(await requestServiceDraft(visitId, 19900)).toMatchObject({ confirmed: false, signIn: false }); expect(fetcher).toHaveBeenCalledTimes(1); });
  it.each([409, 500])("does not display server diagnostics for %s", async status => { fetcher.mockResolvedValue(Response.json({ message: "private diagnostics" }, { status })); const r = await requestServiceDraft(visitId, 19900); expect(r.confirmed).toBe(false); expect(r.message).not.toContain("private diagnostics"); });
  it("offers sign-in after session expiry", async () => { fetcher.mockResolvedValue(Response.json({}, { status: 401 })); expect(await requestServiceDraft(visitId, 19900)).toMatchObject({ confirmed: false, signIn: true }); });
  it("does not retry after a lost response", async () => { fetcher.mockRejectedValue(new Error("lost")); expect(await requestServiceDraft(visitId, 19900)).toMatchObject({ confirmed: false }); expect(fetcher).toHaveBeenCalledTimes(1); });
});
