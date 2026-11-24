import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { inBatches, JOB_PAGE, SupabaseRepository } from "./supabase-repository";

/**
 * Loading every job once there are more than a handful.
 *
 * The day the Housecall Pro history arrived (1,431 jobs), the schedule and
 * the overview broke: the jobs query was silently capped at 1,000 rows, and
 * each follow-up lookup put every job id in its URL, about 39,000 characters,
 * which the API refused. This drives the real client against a stand-in that
 * behaves the same way: at most JOB_PAGE rows per request, and a 400 for any
 * URL over 8,000 characters.
 */

const URL_LIMIT = 8_000;

function jobId(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function jobRow(n: number) {
  return {
    id: jobId(n),
    customer_id: "11111111-1111-4111-8111-111111111111",
    property_id: "22222222-2222-4222-8222-222222222222",
    status: "complete",
    service: "standard",
    freq: "one_time",
    scheduled_start: new Date(Date.UTC(2022, 0, 1) + n * 86_400_000).toISOString(),
    scheduled_end: null,
    schedule_revision: 1,
    price_cents: 15000,
    estimated_clean_minutes: 0,
    customers: { first_name: "Synthetic", last_name: "Customer" },
    properties: { street: "1 Synthetic Way", city: "Dallas", zip: "75201", bedrooms: 2, bathrooms: 1 },
    job_room_scopes: null,
  };
}

function stand_in(total: number, declinedOn: number) {
  const requests: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (String(input).length > URL_LIMIT) {
      return Response.json({ message: "Request URI too long" }, { status: 400 });
    }
    if (url.pathname === "/rest/v1/jobs") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const asked = Number(url.searchParams.get("limit") ?? JOB_PAGE);
      const limit = Math.min(asked, JOB_PAGE);
      const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => jobRow(offset + i));
      return Response.json(rows);
    }
    if (url.pathname === "/rest/v1/visit_cleaner_exclusions" && String(input).includes(jobId(declinedOn))) {
      return Response.json([{ job_id: jobId(declinedOn), cleaner_id: "33333333-3333-4333-8333-333333333333" }]);
    }
    return Response.json([]);
  });
  const db = createClient("https://scale.example.test", "synthetic-key", {
    global: { fetch: fetcher },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { repo: new SupabaseRepository(db), requests };
}

describe("listing every job at scale", () => {
  it("returns every job, in order, past the per-request row ceiling", async () => {
    const { repo, requests } = stand_in(2_350, 2_300);
    const jobs = await repo.listJobs();

    expect(jobs).toHaveLength(2_350);
    expect(jobs.map((j) => j.id)).toEqual(Array.from({ length: 2_350 }, (_, i) => jobId(i)));
    expect(requests.filter((r) => r.pathname === "/rest/v1/jobs")).toHaveLength(3);
  });

  it("keeps every lookup URL inside the limit, and still finds what belongs to the last jobs", async () => {
    const { repo, requests } = stand_in(2_350, 2_300);
    const jobs = await repo.listJobs();

    expect(requests.every((r) => r.toString().length <= URL_LIMIT)).toBe(true);
    expect(jobs.find((j) => j.id === jobId(2_300))?.clientDeclinedCleanerIds).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(jobs.find((j) => j.id === jobId(5))?.clientDeclinedCleanerIds).toEqual([]);
  });

  it("asks for exactly the rows a limited listing wants, in one request", async () => {
    const { repo, requests } = stand_in(2_350, 2_300);
    const jobs = await repo.listJobs({ limit: 25 });

    expect(jobs).toHaveLength(25);
    const jobRequests = requests.filter((r) => r.pathname === "/rest/v1/jobs");
    expect(jobRequests).toHaveLength(1);
    expect(jobRequests[0]!.searchParams.get("limit")).toBe("25");
  });

  it("stops after one short page when there are few jobs", async () => {
    const { repo, requests } = stand_in(9, 0);
    expect(await repo.listJobs()).toHaveLength(9);
    expect(requests.filter((r) => r.pathname === "/rest/v1/jobs")).toHaveLength(1);
  });

  it("handles no jobs at all", async () => {
    const { repo, requests } = stand_in(0, 0);
    expect(await repo.listJobs()).toEqual([]);
    expect(requests.filter((r) => r.pathname !== "/rest/v1/jobs")).toHaveLength(0);
  });
});

describe("splitting a list into batches", () => {
  it("keeps every item, in order, in batches no larger than asked", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = inBatches(items, 100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(items);
    expect(inBatches([], 100)).toEqual([]);
  });
});
