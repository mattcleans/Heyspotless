import { describe, expect, it } from "vitest";
import { toOffer } from "./mappers";
import { DemoRepository } from "./demo-repository";

/**
 * The offer boundary.
 *
 * Two properties matter more than the field mapping: that nothing about the
 * ladder reaches the cleaner, and that an offer she is shown is one she can
 * still answer.
 */

describe("toOffer", () => {
  // Shaped exactly as PostgREST returns it — nested relations, and the job
  // embedded one level down because the offer is the row being selected.
  const row = {
    id: "offer-1",
    job_id: "job-1",
    cleaner_id: "c-marisol",
    payout_cents: 5750,
    estimated_minutes: 138,
    expires_at: "2026-09-10T15:20:00+00:00",
    is_exclusive: true,
    jobs: {
      scheduled_start: "2026-09-10T15:00:00+00:00",
      customers: { first_name: "Ann", last_name: "Lutich" },
      properties: { street: "781 Ohio Dr", city: "Plano", zip: "75024" },
    },
  };

  it("carries enough of the job to decide on it", () => {
    const offer = toOffer(row);
    expect(offer.id).toBe("offer-1");
    expect(offer.jobId).toBe("job-1");
    expect(offer.payoutCents).toBe(5750);
    expect(offer.customerName).toBe("Ann Lutich");
    expect(offer.street).toBe("781 Ohio Dr");
    expect(offer.isExclusive).toBe(true);
    expect(offer.expiresAt.toISOString()).toBe("2026-09-10T15:20:00.000Z");
    expect(offer.scheduledStart?.toISOString()).toBe("2026-09-10T15:00:00.000Z");
  });

  it("carries nothing about the ladder", () => {
    // A rung index, a ceiling or a "this may increase" would teach every
    // rational cleaner to decline the opening rate and wait — which drifts
    // average payout to the ceiling and costs the whole benefit of the ladder.
    const offer = toOffer(row) as unknown as Record<string, unknown>;
    for (const leak of ["tier", "rung", "hourlyRateCents", "payoutPct", "ceiling"]) {
      expect(offer[leak]).toBeUndefined();
    }
  });

  it("survives a job with no customer or property attached", () => {
    const offer = toOffer({ ...row, jobs: { scheduled_start: null } });
    expect(offer.customerName).toBe("Unknown customer");
    expect(offer.street).toBe("");
    expect(offer.scheduledStart).toBeNull();
  });
});

describe("demo offers", () => {
  const repo = new DemoRepository();

  it("signs the cleaner view in as a contractor, not an employee", async () => {
    // Offers, countdowns and an exclusive hold are the contractor experience.
    // A W-2 cleaner is assigned her work, so demoing this screen as an
    // employee would demo something that does not happen.
    const cleaner = await repo.getCleanerByProfile();
    expect(cleaner?.type).toBe("contractor_1099");
  });

  it("only ever shows offers that can still be answered", async () => {
    const offers = await repo.listLiveOffers("c-marisol");
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(offer.payoutCents).toBeGreaterThan(0);
      expect(offer.cleanerId).toBe("c-marisol");
    }
  });

  it("shows both cases that differ — a held customer and an open job", async () => {
    const offers = await repo.listLiveOffers("c-marisol");
    expect(offers.some((o) => o.isExclusive)).toBe(true);
    expect(offers.some((o) => !o.isExclusive)).toBe(true);
  });
});

describe("demo continuity", () => {
  const repo = new DemoRepository();

  it("gives the recurring fixture customers a relationship", async () => {
    // Demo mode is how this app is reviewed, and a board where every visit
    // reads "no relationship" would demo the engine as it was before it had
    // one.
    const jobs = await repo.listJobs();
    const ann = jobs.find((j) => j.id === "j-2");
    expect(ann?.continuity?.preferredCleanerId).toBe("c-marisol");
    expect(ann?.continuity?.priorVisits).toBeGreaterThan(0);
  });

  it("leaves the one-off jobs without one", async () => {
    const jobs = await repo.listJobs();
    const oneOff = jobs.find((j) => j.id === "j-3");
    expect(oneOff?.continuity).toBeUndefined();
  });

  it("names only cleaners who are actually on the roster", async () => {
    // A preference pointing at a cleaner who does not exist would resolve to
    // no hold at all and quietly demo nothing.
    const [jobs, cleaners] = await Promise.all([repo.listJobs(), repo.listCleaners()]);
    const ids = new Set(cleaners.map((c) => c.id));

    for (const job of jobs) {
      for (const id of [job.continuity?.preferredCleanerId, job.continuity?.incumbentCleanerId]) {
        if (id) expect(ids).toContain(id);
      }
    }
  });
});
