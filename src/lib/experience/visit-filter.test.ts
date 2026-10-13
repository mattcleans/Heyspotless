import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/data/types";
import { filterVisits } from "./visit-filter";

const now = new Date("2026-09-29T15:00:00Z");
const jobs = [
  { id: "late", customerName: "Sam Example", street: "123 Oak Lane", city: "Dallas", service: "deep", status: "complete", scheduledStart: new Date("2026-09-30T04:59:00Z") },
  { id: "next", customerName: "Alex Example", street: "456 Pine Lane", city: "Plano", service: "standard", status: "assigned", scheduledStart: new Date("2026-09-30T05:00:00Z") },
  { id: "unknown", customerName: "Pat Example", street: "789 Oak Lane", city: "Dallas", service: "standard", status: "assigned", scheduledStart: null },
] as Job[];

describe("visit filters", () => {
  it("matches every search term across name, address, city, and service without changing input", () => {
    expect(filterVisits(jobs, { q: "  SAM dallas DEEP  " }, now).jobs.map(j => j.id)).toEqual(["late"]);
    expect(jobs.map(j => j.id)).toEqual(["late", "next", "unknown"]);
    expect(filterVisits(jobs, { q: "oak plano" }, now).jobs).toEqual([]);
  });
  it("uses Dallas calendar dates at UTC midnight and excludes unconfirmed times", () => {
    expect(filterVisits(jobs, { day: "2026-09-29" }, now).jobs.map(j => j.id)).toEqual(["late"]);
    expect(filterVisits(jobs, { day: "2026-09-30" }, now).jobs.map(j => j.id)).toEqual(["next"]);
  });
  it("combines history and text filters and exposes visits awaiting a time", () => {
    expect(filterVisits(jobs, { view: "history", q: "sam" }, now).jobs.map(j => j.id)).toEqual(["late"]);
    expect(filterVisits(jobs, { view: "awaitingTime" }, now).jobs.map(j => j.id)).toEqual(["unknown"]);
  });
  it("ignores repeated or invalid parameters and limits search length", () => {
    const result = filterVisits(jobs, { q: ["sam", "alex"], day: "2026-02-30", view: "__proto__" }, now);
    expect(result).toMatchObject({ q: "", day: "", view: "all" });
    expect(result.jobs).toHaveLength(3);
    expect(filterVisits(jobs, { q: "a".repeat(150) }, now).q).toHaveLength(120);
  });
});
