import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractor } from "./fixtures";
const m = vi.hoisted(() => ({ admin: vi.fn(), profile: vi.fn(), customer: vi.fn(), job: vi.fn(), jobs: vi.fn(), cleaners: vi.fn(), expire: vi.fn(), decision: vi.fn(), offer: vi.fn(), assign: vi.fn(), calendar: vi.fn(), recipients: vi.fn(), sms: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/data/supabase-repository", () => ({ SupabaseRepository: class { getCustomerByProfile = m.customer; getJob = m.job; listJobs = m.jobs; listCleaners = m.cleaners; } }));
vi.mock("@/lib/dispatch/store", () => ({ DispatchStore: class { expireStaleOffers = m.expire; recordDecision = m.decision; recordOffer = m.offer; assignDirectly = m.assign; } }));
vi.mock("@/lib/dispatch/calendar-context", () => ({ matchingCalendarInputs: m.calendar }));
vi.mock("@/lib/messaging/store", () => ({ MessagingStore: class { recipientsFor = m.recipients; }, reachabilityOf: () => ({ reachable: false }), OFFER_SENT: "offer_sent" }));
vi.mock("@/lib/messaging/env", () => ({ isMessagingEnabled: () => false }));
vi.mock("@/lib/messaging/gateway", () => ({ sendSms: m.sms }));
vi.mock("@/lib/push/store", () => ({ PushStore: class {} }));
vi.mock("@/lib/push/vapid", () => ({ isPushEnabled: () => false }));
vi.mock("@/lib/push/gateway", () => ({ sendPush: m.push }));
import { runDispatch } from "./run";
const scope = { jobId: "saved-job", customerProfileId: "verified-client" };
const job = { id: "saved-job", customerId: "owned-customer", status: "scheduled", priceCents: 24900, estimatedCleanMinutes: 120, zip: "75201", scheduledStart: new Date("2028-01-21T17:00:00Z"), customerName: "Synthetic Client", street: "Synthetic Preview Way", city: "Dallas", scheduleRevision: 4 };
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2028-01-07T17:00:00Z"));
  m.profile.mockResolvedValue({ data: { role: "customer" }, error: null });
  m.admin.mockReturnValue({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.profile }) }) }) });
  m.customer.mockResolvedValue({ id: "owned-customer" }); m.job.mockResolvedValue(job); m.jobs.mockResolvedValue([job]);
  m.cleaners.mockResolvedValue([contractor({ id: "eligible-cleaner", serviceZips: ["75201"] })]); m.expire.mockResolvedValue(2);
  m.calendar.mockResolvedValue({ eligibilityFor: () => ({}), priorJobsFor: () => 0, scheduledHoursFor: () => 0 });
  m.recipients.mockResolvedValue(new Map()); m.decision.mockResolvedValue({ id: "saved-decision" }); m.offer.mockResolvedValue("saved-offer");
});
afterEach(() => { vi.useRealTimers(); });
describe("shared automatic matching execution", () => {
  it("turns an owned saved request into a revision-bound offer using the real engine", async () => {
    const result = await runDispatch("https://preview.example.test", scope);
    expect(result.offered).toBe(1); expect(m.customer).toHaveBeenCalledWith("verified-client"); expect(m.job).toHaveBeenCalledWith("saved-job");
    expect(m.offer).toHaveBeenCalledWith(expect.objectContaining({ jobId: "saved-job", scheduleRevision: 4, cleanerId: "eligible-cleaner" }));
    expect(m.expire).toHaveBeenCalledWith("saved-job"); expect(m.jobs).not.toHaveBeenCalled(); expect(m.sms).not.toHaveBeenCalled(); expect(m.push).not.toHaveBeenCalled();
  });
  it.each(["cleaner", "admin"])("rechecks a changed role %s before reading jobs or supply", async role => {
    m.profile.mockResolvedValue({ data: { role }, error: null }); await expect(runDispatch("https://preview.example.test", scope)).rejects.toThrow("Client matching access");
    expect(m.customer).not.toHaveBeenCalled(); expect(m.cleaners).not.toHaveBeenCalled(); expect(m.offer).not.toHaveBeenCalled();
  });
  it("never turns a foreign visit into a whole-board matching request", async () => {
    m.job.mockResolvedValue({ ...job, customerId: "someone-else" }); expect((await runDispatch("https://preview.example.test", scope)).jobs).toBe(0);
    expect(m.jobs).not.toHaveBeenCalled(); expect(m.expire).not.toHaveBeenCalled(); expect(m.cleaners).not.toHaveBeenCalled(); expect(m.decision).not.toHaveBeenCalled();
  });
  it.each(["assigned", "in_progress", "complete", "canceled"])("does not rematch a visit now %s", async status => {
    m.job.mockResolvedValue({ ...job, status }); expect((await runDispatch("https://preview.example.test", scope)).jobs).toBe(0); expect(m.offer).not.toHaveBeenCalled();
  });
  it("does not load a job for an account whose customer link disappeared", async () => { m.customer.mockResolvedValue(null); expect((await runDispatch("https://preview.example.test", scope)).jobs).toBe(0); expect(m.job).not.toHaveBeenCalled(); });
  it("reloads the current revision after expiring only the owned visit's offers", async () => {
    m.job.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, scheduleRevision: 5 });
    await runDispatch("https://preview.example.test", scope); expect(m.offer).toHaveBeenCalledWith(expect.objectContaining({ scheduleRevision: 5 }));
  });
  it("does not offer when the visit is canceled during own-offer expiration", async () => {
    m.job.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, status: "canceled" }); expect((await runDispatch("https://preview.example.test", scope)).jobs).toBe(0); expect(m.offer).not.toHaveBeenCalled();
  });
  it("records no-supply decisions without inventing a successful offer", async () => {
    m.cleaners.mockResolvedValue([]); const result = await runDispatch("https://preview.example.test", scope); expect(result.unfilled).toBe(1); expect(result.offered).toBe(0); expect(m.decision).toHaveBeenCalledWith("saved-job", expect.objectContaining({ kind: "no_eligible_cleaner" })); expect(m.offer).not.toHaveBeenCalled();
  });
  it("keeps the saved appointment for review if its time elapsed before matching", async () => {
    m.job.mockResolvedValue({ ...job, scheduledStart: new Date("2028-01-06T17:00:00Z") }); const result = await runDispatch("https://preview.example.test", scope); expect(result.needsScheduling).toBe(1); expect(m.offer).not.toHaveBeenCalled();
  });
  it("retains full-board expiration and retry behavior for protected sweeps", async () => {
    const result = await runDispatch("https://preview.example.test"); expect(result.expiredOffers).toBe(2); expect(m.jobs).toHaveBeenCalledWith({ needingCleaner: true }); expect(m.customer).not.toHaveBeenCalled();
  });
});
