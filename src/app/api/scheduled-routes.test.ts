import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ admin: vi.fn(), plans: vi.fn(), candidates: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/recurring/store", () => ({ RecurringStore: class { listActivePlans = m.plans; } }));
vi.mock("@/lib/billing/store", () => ({ BillingStore: class { listAutochargeCandidates = m.candidates; } }));
import { GET as recurringGet, POST as recurringPost } from "./recurring/generate/route";
import { GET as billingGet, POST as billingPost } from "./billing/autocharge/route";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET","test-secret"); vi.stubEnv("BILLING_ENABLED","0"); vi.stubEnv("DEMO_MODE","0"); m.plans.mockResolvedValue([]); m.candidates.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("configured scheduled routes", () => {
  it.each([[recurringGet,"GET"],[recurringPost,"POST"],[billingGet,"GET"],[billingPost,"POST"]] as const)("denies an unauthenticated invocation", async (handler,method) => { expect((await handler(new NextRequest("https://app.example.test/api/sweep",{method}))).status).toBe(401); expect(m.admin).not.toHaveBeenCalled(); });
  it("accepts Vercel's recurring GET without changing its generation result", async () => {
    const r=await recurringGet(new NextRequest("https://app.example.test/api/recurring/generate",{headers:{authorization:"Bearer test-secret"}})); expect(r.status).toBe(200); expect((await r.json()).plans).toBe(0); expect(m.plans).toHaveBeenCalledOnce();
  });
  it("keeps billing disabled behind the same gate on authenticated GET", async () => {
    const r=await billingGet(new NextRequest("https://app.example.test/api/billing/autocharge",{headers:{authorization:"Bearer test-secret"}})); expect(r.status).toBe(503); expect(m.admin).not.toHaveBeenCalled();
  });
  it("reaches the existing empty billing sweep only when enabled and authenticated", async () => {
    vi.stubEnv("BILLING_ENABLED","1"); const r=await billingGet(new NextRequest("https://app.example.test/api/billing/autocharge",{headers:{authorization:"Bearer test-secret"}})); expect(r.status).toBe(200); expect((await r.json()).swept).toBe(0);
  });
});
