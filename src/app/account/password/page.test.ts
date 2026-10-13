import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { client, demo } = vi.hoisted(() => ({ client: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: demo }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
import PasswordPage from "./page";
const page = (next = "/customer") =>
  PasswordPage({ searchParams: Promise.resolve({ next }) });
beforeEach(() => {
  client.mockReset();
  demo.mockReturnValue(false);
});

describe("password settings access", () => {
  it("requires verified authentication and preserves the intended return page", async () => {
    client.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    });
    await expect(page()).rejects.toThrow(
      "REDIRECT:/login?next=%2Faccount%2Fpassword%3Fnext%3D%252Fcustomer",
    );
  });
  it("does not render a password editor when authentication verification fails", async () => {
    client.mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "unverified" } },
          error: { code: "bad_jwt" },
        }),
      },
    });
    await expect(page()).rejects.toThrow("REDIRECT:/login?");
  });
  it("shows only the verified account email and new-password fields", async () => {
    client.mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "owner", email: "owner@example.test" } },
          error: null,
        }),
      },
    });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("owner@example.test");
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html).toContain("Save password");
    expect(html).not.toContain("current-password");
  });
  it("keeps the demo read-only without accessing Auth", async () => {
    demo.mockReturnValue(true);
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("real account");
    expect(html).not.toContain("Save password");
    expect(client).not.toHaveBeenCalled();
  });
});
