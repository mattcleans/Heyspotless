import type { Job } from "@/lib/data/types";
import type { RoomCounts } from "@/lib/pricing/quote";
import { photoGaps, type JobPhoto } from "@/lib/service/completion";
import { roomsFor } from "@/lib/service/rooms";

export const REVIEW_LIMIT = 200;
export const isReviewId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export interface ReviewPhoto extends JobPhoto { id: string; takenAt: Date; }
export interface ReviewInvoice { id: string; status: string; totalCents: number; balanceCents: number; }
export interface VisitFacts {
  startedAt: Date | null;
  completedAt: Date | null;
  invoicedAt: Date | null;
  photos: ReviewPhoto[];
  issues: ReviewPhoto[];
  assignments: { id: string; name: string; phone: string | null }[];
  invoices: ReviewInvoice[];
}
export interface ReviewVisit { job: Job; completedAt: Date | null; }

export function reviewRooms(counts: RoomCounts) {
  const values = [counts.bedrooms, counts.bathrooms, counts.halfBaths ?? 0,
    counts.kitchens ?? 1, counts.livingRooms ?? 1, counts.utilityRooms ?? 1];
  if (values.some(n => !Number.isSafeInteger(n) || n < 0) || values.reduce((sum,n)=>sum+n,0) > 250) {
    throw new Error("Review this home's room counts before checking its photos.");
  }
  return roomsFor(counts);
}

/** This describes recorded evidence and invoices, never payment initiation. */
export function reviewState(status: string, rooms: RoomCounts, facts: VisitFacts) {
  reviewRooms(rooms);
  const gaps = photoGaps(rooms, facts.photos);
  if (facts.invoices.length > 0) return { key: "recorded", label: "Invoice recorded", gaps };
  if (facts.invoicedAt) return { key: "unavailable", label: "Check invoice record", gaps };
  if (status !== "complete") return { key: "unfinished", label: "Visit not complete", gaps };
  if (gaps.length > 0) return { key: "photos", label: "Photos outstanding", gaps };
  return { key: "ready", label: "Ready for invoice review", gaps };
}

export function demoReviewVisits(jobs: Job[]): ReviewVisit[] {
  const job = jobs[0];
  if (!job) return [];
  return ["review-sample-photos", "review-sample-invoice"].map((id) => ({
    job: { ...job, id, status: "complete" }, completedAt: new Date("2026-10-01T16:00:00Z"),
  }));
}
