import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { exchange, client } = vi.hoisted(() => ({
  exchange: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
import { GET } from "./route";
const request = (query: string) =>
  new NextRequest(`https://app.example.test/auth/callback${query}`);
beforeEach(() => {
  client.mockReset();
  exchange.mockReset();
  client.mockResolvedValue({ auth: { exchangeCodeForSession: exchange } });
  exchange.mockResolvedValue({ error: null });
});
describe("email callback", () => {
  it("continues through verified role routing after exchanging the code", async () => {
    const response = await GET(request("?code=test-code&next=%2Fadmin"));
    expect(exchange).toHaveBeenCalledWith("test-code");
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/auth/continue?next=%2Fadmin",
    );
  });
  it("preserves the requested workspace when a link is invalid", async () => {
    exchange.mockResolvedValue({ error: { message: "expired" } });
    const response = await GET(request("?code=expired&next=%2Fadmin"));
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/login?error=invalid_code&next=%2Fadmin",
    );
  });
  it("handles missing codes without touching auth", async () => {
    expect((await GET(request(""))).headers.get("location")).toContain(
      "error=missing_code",
    );
    expect(client).not.toHaveBeenCalled();
  });
  it("makes thrown service failures recoverable", async () => {
    client.mockRejectedValue(new Error("offline"));
    expect(
      (await GET(request("?code=test"))).headers.get("location"),
    ).toContain("error=service_unavailable");
  });
  it("rejects provider errors and external redirects", async () => {
    expect(
      (
        await GET(request("?error=access_denied&next=%2F%2Fevil.test"))
      ).headers.get("location"),
    ).toBe("https://app.example.test/login?error=invalid_code&next=%2F");
  });
});
it("restores the destination from the fixed callback's cookie and clears it", async () => {
  const req = request("?code=test");
  req.cookies.set("hs_login_next", "%2Fadmin%2Fcustomers");
  const response = await GET(req);
  expect(response.headers.get("location")).toBe(
    "https://app.example.test/auth/continue?next=%2Fadmin%2Fcustomers",
  );
  expect(response.cookies.get("hs_login_next")?.value).toBe("");
});
it("does not trust an external destination in the cookie", async () => {
  const req = request("?code=test");
  req.cookies.set("hs_login_next", "%2F%2Fevil.test");
  expect((await GET(req)).headers.get("location")).toBe(
    "https://app.example.test/auth/continue?next=%2F",
  );
});
