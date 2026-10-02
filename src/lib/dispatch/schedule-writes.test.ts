import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { DispatchStore, passedOverFor, offeredUpToFor } from "./store";
const rpc = vi.fn();
const db = { rpc } as unknown as SupabaseClient;
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});
describe("dispatch appointment revisions", () => {
  it("sends the loaded schedule revision with an offer", async () => {
    await new DispatchStore(db).recordOffer({
      jobId: "job",
      scheduleRevision: 8,
      cleanerId: "cleaner",
      decisionId: null,
      channel: "open_board",
      tier: 1,
      share: 0.4,
      payoutCents: 8000,
      estimatedMinutes: 90,
      expiresAt: new Date("2026-10-03T14:00:00Z"),
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_offer_for_schedule",
      expect.objectContaining({ p_schedule_revision: 8, p_job_id: "job" }),
    );
  });
  it("sends the revision with employee assignments", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(
      await new DispatchStore(db).assignDirectly("job", "cleaner", 8000, 8),
    ).toBe(false);
    expect(rpc).toHaveBeenCalledWith("assign_job_for_schedule", {
      p_job_id: "job",
      p_cleaner_id: "cleaner",
      p_payout_cents: 8000,
      p_schedule_revision: 8,
    });
  });
  const rows = [
    {
      job_id: "job",
      cleaner_id: "old",
      payout_pct: 0.7,
      schedule_revision: 1,
      jobs: { schedule_revision: 2 },
    },
    {
      job_id: "job",
      cleaner_id: "current",
      payout_pct: 0.4,
      schedule_revision: 2,
      jobs: { schedule_revision: 2 },
    },
  ];
  function query(data: unknown) {
    const q = { select: vi.fn(), in: vi.fn() };
    q.select.mockReturnValue(q);
    q.in.mockImplementation((_k: string, v: unknown) =>
      Array.isArray(v) && v.includes("declined")
        ? Promise.resolve({ data, error: null })
        : Object.assign(q, {
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data, error: null }).then(resolve),
          }),
    );
    return { from: () => q } as unknown as SupabaseClient;
  }
  it("does not hold old appointment declines against matching for the new time", async () => {
    expect(await passedOverFor(query(rows), ["job"])).toEqual(
      new Map([["job", [{ cleanerId: "current", share: 0.4 }]]]),
    );
  });
  it("restarts the ladder for the new appointment", async () => {
    expect(await offeredUpToFor(query(rows), ["job"])).toEqual(
      new Map([["job", 0.4]]),
    );
  });
  it("does not infer an offer revision from malformed data", async () => {
    expect(
      await offeredUpToFor(query([{ job_id: "job", payout_pct: 0.8 }]), [
        "job",
      ]),
    ).toEqual(new Map());
  });
});
