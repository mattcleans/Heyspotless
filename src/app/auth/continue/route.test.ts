import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { client, demo } = vi.hoisted(() => ({ client: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: demo }));
import { GET } from "./route";
const request = (next = "%2Fadmin") =>
  new NextRequest(`https://app.example.test/auth/continue?next=${next}`);
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
  it("takes a new Client to self-service home setup", async () => {
    session("customer", false);
    expect((await GET(request())).headers.get("location")).toBe(
      "https://app.example.test/customer/account/homes/new",
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
  it.each([
    ["new Client", "customer", false],
    ["unlinked Cleaner", "cleaner", false],
    ["account without a profile", null, true],
  ])("lets a %s finish a password reset before setup", async (_, role, linked) => {
    session(role as string | null, linked as boolean);
    expect(
      (await GET(request("%2Faccount%2Fpassword%3Fnext%3D%252Fcustomer"))).headers.get("location"),
    ).toBe("https://app.example.test/account/password?next=%2Fcustomer");
  });
});
