import { describe, expect, it, vi } from "vitest";
import { saveOwnPassword } from "./password";

function auth(
  userId: string | null = "owner",
  error: { code?: string } | null = null,
) {
  return {
    getUser: vi.fn(async () => ({
      data: { user: userId ? { id: userId } : null },
      error,
    })),
    updateUser: vi.fn(async () => ({
      error: null as { code?: string } | null,
    })),
  };
}

describe("authenticated password updates", () => {
  it.each(["admin", "cleaner", "customer"])(
    "lets the verified %s owner save the exact password without changing profile roles",
    async (role) => {
      const session = auth(role);
      const password = " a unique test passphrase ";
      expect(
        await saveOwnPassword(session, role, password, password),
      ).toBeNull();
      expect(session.updateUser).toHaveBeenCalledExactlyOnceWith({ password });
    },
  );
  it.each([null, "another-account"])(
    "never updates a missing or changed session (%s)",
    async (id) => {
      const session = auth(id);
      expect(
        await saveOwnPassword(session, "owner", "long enough", "long enough"),
      ).toBeTruthy();
      expect(session.updateUser).not.toHaveBeenCalled();
    },
  );
  it("does not trust a user returned alongside an authentication error", async () => {
    const session = auth("owner", { code: "bad_jwt" });
    expect(
      await saveOwnPassword(session, "owner", "long enough", "long enough"),
    ).toContain("Sign in again");
    expect(session.updateUser).not.toHaveBeenCalled();
  });
  it("rejects mismatching passwords before making any auth request", async () => {
    const session = auth();
    expect(
      await saveOwnPassword(
        session,
        "owner",
        "long enough",
        "different password",
      ),
    ).toContain("don’t match");
    expect(session.getUser).not.toHaveBeenCalled();
    expect(session.updateUser).not.toHaveBeenCalled();
  });
  it("keeps provider password policy failures actionable without exposing the provider response", async () => {
    const session = auth();
    session.updateUser.mockResolvedValue({ error: { code: "weak_password" } });
    expect(
      await saveOwnPassword(session, "owner", "long enough", "long enough"),
    ).toContain("stronger password");
  });
});
