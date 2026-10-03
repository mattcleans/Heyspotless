import { isChoiceId } from "@/lib/customer/cleaner-choice/input";

export const CREW_STATES = [
  "review",
  "sent",
  "accepted",
  "declined",
  "withdrawn",
  "expired",
  "conflict",
] as const;
export interface CrewReceipt {
  id: string;
  jobId: string;
  cleanerName: string;
  type: "w2_core" | "contractor_1099";
  payoutCents: number;
  hourlyRateCents: number | null;
  start: string;
  minutes: number;
  clientPriceCents: number;
  expiresAt: string;
  state: (typeof CREW_STATES)[number];
  assignmentId: string | null;
  assignmentCurrent: boolean;
  clientApproved: boolean;
  needsClientApproval: boolean;
  city: string;
}
export interface CrewMember {
  id: string;
  name: string;
  isLead: boolean;
  payoutCents: number;
  type: "w2_core" | "contractor_1099";
}
export interface CrewReview {
  canReplace: boolean;
  start: string;
  clientPriceCents: number;
  crew: CrewMember[];
  candidates: {
    id: string;
    name: string;
    type: "w2_core" | "contractor_1099";
  }[];
  proposals: CrewReceipt[];
}
const failure = () =>
  new Error("Crew details are unavailable. Refresh and review the visit.");
function row(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw failure();
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw failure();
  return v;
}
function id(v: unknown): string {
  if (!isChoiceId(v)) throw failure();
  return v;
}
function cents(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw failure();
  return v;
}
function instant(v: unknown): string {
  const s = text(v);
  if (!Number.isFinite(Date.parse(s))) throw failure();
  return s;
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") throw failure();
  return v;
}
function kind(v: unknown): CrewMember["type"] {
  if (v !== "w2_core" && v !== "contractor_1099") throw failure();
  return v;
}
function list<T>(v: unknown, parse: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw failure();
  return v.map(parse);
}
export function toCrewReceipt(v: unknown): CrewReceipt {
  const r = row(v),
    state = r.state;
  if (!CREW_STATES.includes(state as CrewReceipt["state"])) throw failure();
  const result = {
    id: id(r.id),
    jobId: id(r.jobId),
    cleanerName: text(r.cleanerName),
    type: kind(r.type),
    payoutCents: cents(r.payoutCents),
    hourlyRateCents:
      r.hourlyRateCents === null ? null : cents(r.hourlyRateCents),
    start: instant(r.start),
    minutes: cents(r.minutes),
    clientPriceCents: cents(r.clientPriceCents),
    expiresAt: instant(r.expiresAt),
    state: state as CrewReceipt["state"],
    assignmentId: r.assignmentId === null ? null : id(r.assignmentId),
    assignmentCurrent: bool(r.assignmentCurrent),
    clientApproved: bool(r.clientApproved),
    needsClientApproval: bool(r.needsClientApproval),
    city: text(r.city),
  };
  if (
    (result.state === "accepted") !== (result.assignmentId !== null) ||
    (result.state !== "accepted" &&
      (result.assignmentCurrent || result.clientApproved)) ||
    (result.type === "w2_core" &&
      (result.payoutCents !== 0 || !result.hourlyRateCents))
  )
    throw failure();
  return result;
}
export function toCrewMember(v: unknown): CrewMember {
  const r = row(v);
  return {
    id: id(r.id),
    name: text(r.name),
    isLead: bool(r.isLead),
    payoutCents: cents(r.payoutCents),
    type: kind(r.type),
  };
}
export function toCrewReview(v: unknown): CrewReview {
  const r = row(v);
  return {
    canReplace: bool(r.canReplace),
    start: instant(r.start),
    clientPriceCents: cents(r.clientPriceCents),
    crew: list(r.crew, toCrewMember),
    proposals: list(r.proposals, toCrewReceipt),
    candidates: list(r.candidates, (x) => {
      const c = row(x);
      return { id: id(c.id), name: text(c.name), type: kind(c.type) };
    }),
  };
}
export function toCrewQuote(v: unknown) {
  const r = row(v);
  const receipt = toCrewReceipt(v);
  if (receipt.state !== "review") throw failure();
  const reviewCrew = list(r.reviewCrew, toCrewMember);
  if (
    reviewCrew.length < 2 ||
    reviewCrew.filter((c) => c.isLead).length !== 1 ||
    new Set(reviewCrew.map((c) => c.id)).size !== reviewCrew.length
  )
    throw failure();
  return { ...receipt, reviewCrew };
}
export function crewMessage(r: CrewReceipt): string {
  switch (r.state) {
    case "review":
      return "Review these details before confirming.";
    case "sent":
      return "Offer sent. The current crew stays assigned until the replacement accepts.";
    case "accepted":
      if (!r.assignmentCurrent)
        return "This replacement was accepted earlier. Check the current visit; this receipt does not confirm a current assignment.";
      if (r.clientApproved && r.needsClientApproval)
        return "Replacement assigned and approved by the client. Review the current visit before starting.";
      return r.needsClientApproval
        ? "Replacement assigned. The client must approve this backup before the crew starts."
        : "The client’s requested cleaner is assigned. Review the visit before starting.";
    case "declined":
      return "The cleaner passed on this offer. The current crew stays assigned; the office can review another replacement.";
    case "withdrawn":
      return "This replacement is no longer available. Review the latest visit before making another offer.";
    case "expired":
      return "This replacement expired. Review again to arrange a new offer.";
    case "conflict":
      return "The replacement is no longer eligible or available. The current crew stays assigned; review another cleaner.";
  }
}
export type CrewAction =
  | { action: "quote"; jobId: string; cleanerId: string }
  | { action: "confirm" | "withdraw"; id: string };
export function parseCrewAction(v: unknown): CrewAction {
  const r = row(v);
  if (r.action === "quote")
    return { action: "quote", jobId: id(r.jobId), cleanerId: id(r.cleanerId) };
  if (r.action === "confirm" || r.action === "withdraw")
    return { action: r.action, id: id(r.id) };
  throw failure();
}
export function parseCrewAnswer(v: unknown) {
  const r = row(v);
  return { id: id(r.id), accept: bool(r.accept) };
}
