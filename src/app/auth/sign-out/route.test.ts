import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { signOut, client, demo } = vi.hoisted(() => ({
  signOut: vi.fn(),
  client: vi.fn(),
  demo: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: demo }));
import { POST } from "./route";
const request = () =>
  new NextRequest("https://app.example.test/auth/sign-out", { method: "POST" });
beforeEach(() => {
  client.mockReset();
  signOut.mockReset();
  demo.mockReset();
  demo.mockReturnValue(false);
  client.mockResolvedValue({ auth: { signOut } });
  signOut.mockResolvedValue({ error: null });
});
describe("sign out", () => {
  it("ends the session and lands on sign-in", async () => {
    const response = await POST(request());
    expect(signOut).toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/login",
    );
  });
  it("says so when Supabase refuses", async () => {
    signOut.mockResolvedValue({ error: { message: "nope" } });
    expect((await POST(request())).headers.get("location")).toContain(
      "error=sign_out_failed",
    );
  });
  it("says so when the service is unreachable", async () => {
    client.mockRejectedValue(new Error("offline"));
    expect((await POST(request())).headers.get("location")).toContain(
      "error=sign_out_failed",
    );
  });
  it("skips auth entirely in demo mode", async () => {
    demo.mockReturnValue(true);
    const response = await POST(request());
    expect(client).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/login",
    );
  });
});
