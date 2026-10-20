import { describe, expect, it, vi } from "vitest";
import { verifySchedulerTarget } from "./scheduler-target";

const origin = "https://app.heyspotless.com";
const secret = "synthetic-scheduler-secret";
const healthy = () => ({
  cron: { secret: true },
  deploy: { environment: "production" },
  supabase: {
    projectUrl: "https://swxaupitauibkatljfnt.supabase.co",
    configured: true, serviceRoleKey: true, demoMode: false,
  },
  database: { reachable: true },
});
const reply = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));

describe("production scheduler preflight", () => {
  it("accepts the protected production report without posting a sweep", async () => {
    const fetcher = reply(healthy());
    await verifySchedulerTarget(origin, secret, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${origin}/api/health`);
    expect(options).toMatchObject({ headers: { "x-cron-secret": secret }, redirect: "error" });
    expect(options?.method ?? "GET").toBe("GET");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([undefined, ""])("rejects a missing secret (%s) before any request", async (value) => {
    const fetcher = reply(healthy());
    await expect(verifySchedulerTarget(origin, value, fetcher)).rejects.toThrow("Set APP_URL and CRON_SECRET");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined, "not a URL", "http://app.heyspotless.com", "https://preview.example.test",
    "https://user:password@app.heyspotless.com", `${origin}/customer`, `${origin}?key=1`, `${origin}#fragment`,
  ])("does not send the credential to an invalid target (%s)", async (url) => {
    const fetcher = reply(healthy());
    await expect(verifySchedulerTarget(url, secret, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects public liveness even though it is HTTP 200", async () => {
    await expect(verifySchedulerTarget(origin, secret, reply({ ok: true }))).rejects.toThrow("Synchronize GitHub CRON_SECRET");
  });

  it.each(["preview", "local"])("rejects an authenticated %s deployment", async (environment) => {
    const body = healthy(); body.deploy.environment = environment;
    await expect(verifySchedulerTarget(origin, secret, reply(body))).rejects.toThrow("not the production database");
  });

  it("rejects a production deployment connected to the isolated preview", async () => {
    const body = healthy(); body.supabase.projectUrl = "https://bdkgvlwxyyfyohyplzap.supabase.co";
    await expect(verifySchedulerTarget(origin, secret, reply(body))).rejects.toThrow("not the production database");
  });

  it("rejects demo mode", async () => {
    const body = healthy(); body.supabase.demoMode = true;
    await expect(verifySchedulerTarget(origin, secret, reply(body))).rejects.toThrow("not the production database");
  });

  it.each(["configured", "serviceRoleKey", "reachable"])("rejects unavailable %s", async (field) => {
    const body = healthy();
    if (field === "reachable") body.database.reachable = false;
    else if (field === "configured") body.supabase.configured = false;
    else body.supabase.serviceRoleKey = false;
    await expect(verifySchedulerTarget(origin, secret, reply(body))).rejects.toThrow("Sweep was not started");
  });

  it("does not echo an HTTP error body", async () => {
    await expect(verifySchedulerTarget(origin, secret, reply({ error: secret }, 503))).rejects.toThrow("HTTP 503");
  });

  it("explains an HTML login page without printing it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`<html>${secret}</html>`));
    await expect(verifySchedulerTarget(origin, secret, fetcher)).rejects.toThrow("did not return JSON");
  });

  it("does not echo a transport error containing the credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(secret));
    await expect(verifySchedulerTarget(origin, secret, fetcher)).rejects.toThrow("health request failed or redirected");
    await expect(verifySchedulerTarget(origin, secret, fetcher)).rejects.not.toThrow(secret);
  });
});
