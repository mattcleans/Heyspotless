import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/dispatch/run", () => ({ runDispatch: m.run }));
import { GET, POST } from "./route";
const request = (method: string, headers: Record<string, string> = {}) => new NextRequest("https://app.example.test/api/dispatch/run?jobId=caller-input", { method, headers });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "test-secret"); m.run.mockResolvedValue({ jobs: 1, offered: 1 }); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("protected matching invocations", () => {
  it.each([[GET,"GET"],[POST,"POST"]] as const)("denies unauthenticated %s", async (handler, method) => { expect((await handler(request(method))).status).toBe(401); expect(m.run).not.toHaveBeenCalled(); });
  it.each(["wrong", "Bearer test-secret-extra", "Basic test-secret"])("refuses malformed authorization %s", async authorization => { expect((await GET(request("GET", { authorization }))).status).toBe(401); expect(m.run).not.toHaveBeenCalled(); });
  it("accepts Vercel's Bearer GET and does not forward caller-controlled job scope", async () => { expect((await GET(request("GET", { authorization: "Bearer test-secret" }))).status).toBe(200); expect(m.run).toHaveBeenCalledWith("https://app.example.test"); });
  it("retains the manual POST secret header", async () => { expect((await POST(request("POST", { "x-cron-secret": "test-secret" }))).status).toBe(200); });
  it("fails closed when the configured secret is absent", async () => { vi.stubEnv("CRON_SECRET", ""); expect((await GET(request("GET", { authorization: "Bearer test-secret" }))).status).toBe(401); expect(m.run).not.toHaveBeenCalled(); });
});
