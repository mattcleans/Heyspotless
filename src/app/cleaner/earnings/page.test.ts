import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { toPayRecord } from "@/lib/cleaners/earnings";
const mocks = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), load: vi.fn(), linked: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: mocks.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/cleaners/earnings-store", () => ({ loadCleanerPay: mocks.load, PAY_RECORD_LIMIT: 200 }));
import EarningsPage from "./page";

function account(role: string | null) {
  mocks.repo.mockResolvedValue({ isDemo: false, getCurrentProfile: async () => role ? { id: "profile-self", role } : null, getCleanerByProfile: mocks.linked });
}
const render = async (query = {}) => renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve(query) }));
const record = { id: "p1", job_id: "old-job", amount_cents: 5000, mileage_cents: 100, tip_cents: 1000, tip_fee_cents: 29, tip_net_cents: 971, created_at: "2026-10-01T15:00:00Z", paid_at: null };
beforeEach(() => {
  vi.clearAllMocks(); account("cleaner");
  mocks.linked.mockResolvedValue({ id: "cleaner-self", type: "contractor_1099", status: "paused" });
  mocks.client.mockResolvedValue({ requestScoped: true });
  mocks.load.mockResolvedValue({ records: [], assignments: [], tipsAvailable: true });
});
describe("my pay screen", () => {
  it.each([null, "customer", "admin"])("prevents role %s from reaching a pay query", async role => {
    account(role);
    expect(await render()).toContain("Sign in with your cleaner account");
    expect(mocks.linked).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("never loads records for an unlinked profile", async () => {
    mocks.linked.mockResolvedValue(null);
    await render();
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("lets a paused cleaner review their own history", async () => {
    expect(await render()).toContain("No pay records yet");
    expect(mocks.linked).toHaveBeenCalledWith("profile-self");
    expect(mocks.load).toHaveBeenCalledWith({ requestScoped: true }, "cleaner-self");
  });
  it("shows an empty history as missing records, not a zero payment balance", async () => {
    const html = await render();
    expect(html).toContain("does not automatically create a payment record");
    expect(html).not.toContain("$0.00");
  });
  it("labels partial legacy totals and never assumes unknown tips are zero", async () => {
    mocks.load.mockResolvedValue({ records: [toPayRecord(record, false)], assignments: [], tipsAvailable: false });
    const html = await render();
    expect(html).toContain("Tip details aren’t available here yet");
    expect(html).toContain("Work and mileage subtotal");
    expect(html).not.toContain("Tip to you");
  });
  it("does not link a payout's old job unless an accessible assignment was loaded", async () => {
    mocks.load.mockResolvedValue({ records: [toPayRecord(record, true)], assignments: [], tipsAvailable: true });
    expect(await render()).not.toContain("/cleaner/job/old-job");
  });
  it("keeps agreed visit pay out of payment totals and excludes canceled assignments", async () => {
    mocks.load.mockResolvedValue({ records: [toPayRecord(record, true)], assignments: [
      { jobId: "visit", agreedCents: 9900, status: "complete", customerName: "Ann", street: "Test street", scheduledStart: null },
      { jobId: "canceled", agreedCents: 40000, status: "canceled", customerName: "Canceled customer", street: "", scheduledStart: null },
    ], tipsAvailable: true });
    const html = await render();
    expect(html).toContain("$60.71"); expect(html).toContain("$99.00");
    expect(html).toContain("They exclude agreed visit amounts");
    expect(html).not.toContain("Canceled customer"); expect(html).not.toContain("$159.71");
  });
  it("does not present an imported zero assignment as confirmed pay", async () => {
    mocks.load.mockResolvedValue({ records: [], assignments: [{ jobId: "visit", agreedCents: 0, status: "complete", customerName: "Ann", street: "", scheduledStart: null }], tipsAvailable: true });
    expect(await render()).toContain("Confirm pay with the office");
  });
  it("shows employee hourly terms without presenting contractor assignment amounts", async () => {
    mocks.linked.mockResolvedValue({ id: "cleaner-self", type: "w2_core", terms: { hourlyRateCents: 2100, guaranteedHoursPerWeek: 40 } });
    const html = await render();
    expect(html).toContain("$21.00"); expect(html).toContain("guaranteed hours per week");
    expect(html).not.toContain("Agreed visit pay");
  });
  it("shows filter recovery without presenting unfiltered totals as matching", async () => {
    mocks.load.mockResolvedValue({ records: [toPayRecord(record, true)], assignments: [], tipsAvailable: true });
    const html = await render({ from: "2026-10-03", through: "2026-10-01" });
    expect(html).toContain("end date must be on or after"); expect(html).not.toContain("$60.71");
    expect(html).toContain('value="2026-10-03"'); expect(html).toContain('value="2026-10-01"');
  });
});
