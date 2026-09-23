import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { client, demo } = vi.hoisted(() => ({ client: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: demo }));
import { GET } from "./route";
const request = () =>
  new NextRequest("https://app.example.test/auth/continue?next=%2Fadmin");
function session(role: string | null, linked = true, queryError = false) {
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data:
            table === "profiles"
              ? role
                ? { role }
                : null
              : linked
                ? { id: "record" }
                : null,
          error: queryError ? { message: "offline" } : null,
        }),
      }),
    }),
  }));
  client.mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: "user" } }, error: null }),
    },
    from,
  });
  return from;
}
beforeEach(() => {
  client.mockReset();
  demo.mockReturnValue(false);
});
describe("post-login routing", () => {
  it("takes a verified owner to Management", async () => {
    session("admin");
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/admin",
    );
  });
  it("takes a linked customer to their own workspace", async () => {
    session("customer");
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/customer",
    );
  });
  it("explains a missing customer link rather than displaying empty data", async () => {
    session("customer", false);
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/account-setup",
    );
  });
  it("explains a missing cleaner link", async () => {
    session("cleaner", false);
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/account-setup",
    );
  });
  it("explains a missing profile", async () => {
    session(null);
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/account-setup",
    );
  });
  it("distinguishes a database failure from missing setup", async () => {
    session("admin", true, true);
    expect((await GET(request())).headers.get("location")).toContain(
      "error=service_unavailable",
    );
  });
  it("requires a validated session", async () => {
    client.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    });
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/login?next=%2Fadmin",
    );
  });
});
