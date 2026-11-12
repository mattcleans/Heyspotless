import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isJobReadReady } from "./job-read-readiness";

function client(fetcher: typeof fetch) {
  return createClient("https://schema-readiness.example.test", "synthetic-key", {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe("dispatch query readiness using the real PostgREST client", () => {
  it("resolves the complete repository projection with zero rows and a timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    expect(await isJobReadReady(client(fetcher))).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/rest/v1/jobs");
    expect(url.searchParams.get("limit")).toBe("0");
    const projection = url.searchParams.get("select");
    expect(projection).toContain("job_room_scopes(");
    expect(projection).toContain("source,captured_at");
    expect(projection).toContain("customers(first_name,last_name)");
    expect(projection).toContain("properties(street,city,zip,bedrooms,bathrooms)");
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not confuse a reachable database with a missing saved-scope relationship", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: "PGRST200", message: "Could not find a relationship for job_room_scopes",
    }, { status: 400 }));
    expect(await isJobReadReady(client(fetcher))).toBe(false);
  });

  it("fails closed on unavailable or interrupted reads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("synthetic interrupted read", "AbortError"));
    expect(await isJobReadReady(client(fetcher))).toBe(false);
  });
});
