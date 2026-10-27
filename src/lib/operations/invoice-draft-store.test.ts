import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { SupabaseClient } from "@supabase/supabase-js";
import { DraftPriceChanged, prepareServiceDraft } from "./invoice-draft-store";
const client = (result: unknown) => ({ rpc: vi.fn().mockResolvedValue(result) }) as unknown as SupabaseClient;
describe("reviewed draft store", () => {
  it("passes the reviewed price to the single guarded routine", async () => {
    const db = client({ data: "receipt", error: null });
    expect(await prepareServiceDraft(db, "job", 19900)).toBe("receipt");
    expect(db.rpc).toHaveBeenCalledWith("prepare_job_service_draft", { p_job_id: "job", p_reviewed_price_cents: 19900 });
  });
  it("classifies only the database's stale-price outcome", async () => {
    await expect(prepareServiceDraft(client({ data: null, error: { code: "PFD01" } }), "job", 19900)).rejects.toBeInstanceOf(DraftPriceChanged);
  });
  it("does not pass database diagnostics to callers", async () => {
    await expect(prepareServiceDraft(client({ data: null, error: { code: "XX000", message: "private details" } }), "job", 19900)).rejects.toThrow("The service draft could not be confirmed.");
  });
});
