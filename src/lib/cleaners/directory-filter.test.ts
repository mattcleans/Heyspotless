import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CleanerDirectory } from "./store";
import type { SupabaseClient } from "@supabase/supabase-js";
function fixture(
  result: { data: unknown; error: unknown } = { data: [], error: null },
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const q: Record<string, unknown> = {};
  for (const method of ["select", "or", "order", "limit"])
    q[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return q;
    };
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  const db = { from: () => q } as unknown as SupabaseClient;
  return { directory: new CleanerDirectory(db), calls };
}
describe("published profile service-area filtering", () => {
  it("filters ZIP and wildcard profiles in the database before bounding results", async () => {
    const { directory, calls } = fixture();
    await directory.servingZip("75001", 24);
    expect(calls.find((c) => c.method === "or")?.args).toEqual([
      "service_zips.eq.{},service_zips.cs.{75001}",
    ]);
    expect(calls.findIndex((c) => c.method === "or")).toBeLessThan(
      calls.findIndex((c) => c.method === "limit"),
    );
    expect(calls.at(-1)).toEqual({ method: "limit", args: [24] });
  });
  it.each(["75001),id.eq.secret", "7500", ""])(
    "rejects invalid/injected ZIP %s",
    async (zip) => {
      const { directory, calls } = fixture();
      await expect(directory.servingZip(zip)).rejects.toThrow();
      expect(calls).toEqual([]);
    },
  );
  it.each([0, 101, 1.5])("rejects invalid bounds %s", async (limit) => {
    await expect(
      fixture().directory.servingZip("75001", limit),
    ).rejects.toThrow();
  });
  it.each([
    { data: null, error: null },
    { data: [], error: { message: "denied" } },
  ])("does not report unreadable profiles as no matches %j", async (result) => {
    await expect(fixture(result).directory.servingZip("75001")).rejects.toThrow(
      "could not be loaded",
    );
  });
});
