import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ServiceStore, BackupApprovalRequired } from "./store";
import type { SupabaseClient } from "@supabase/supabase-js";
for (const action of ["start", "complete"] as const)
  describe(`${action} backup approval`, () => {
    it("turns the database consent gate into a recoverable policy error", async () => {
      const db = {
        rpc: vi
          .fn()
          .mockResolvedValue({
            data: null,
            error: { code: "PBC01", message: "internal" },
          }),
      } as unknown as SupabaseClient;
      await expect(
        new ServiceStore(db)[action]("visit", "cleaner"),
      ).rejects.toBeInstanceOf(BackupApprovalRequired);
    });
    it.each([null, false, "true", {}])(
      "does not claim %j confirms success",
      async (data) => {
        const db = {
          rpc: vi.fn().mockResolvedValue({ data, error: null }),
        } as unknown as SupabaseClient;
        expect(await new ServiceStore(db)[action]("visit", "cleaner")).toBe(
          false,
        );
      },
    );
  });
