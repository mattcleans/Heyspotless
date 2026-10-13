/**
 * What the customer sees while somebody is in their house.
 *
 * THE STAGE, NOT THE PERSON. The design put a live map here with the cleaner's
 * position on it. That did not survive review: continuous position tracking of
 * a 1099 contractor is close to the centre of what worker classification turns
 * on (`docs/setup.md` item 9), and `0020` already refused to store even a
 * completion coordinate for the same reason.
 *
 * What replaces it is better anyway. "She is 1.4 miles away" answers nothing
 * anybody can act on; "she is four rooms in and finishing about 11:30" is the
 * actual question — is it going well, and when do I get my house back. All of
 * it comes from what the job already records.
 *
 * Pure, so the stage rules can be asserted without a database.
 */

export type VisitStage = "scheduled" | "accepted" | "cleaning" | "done" | "canceled";

export const STAGES: readonly VisitStage[] = ["scheduled", "accepted", "cleaning", "done"];

/** What each stage is called on the tracker, in the customer's language. */
export const STAGE_LABELS: Record<VisitStage, string> = {
  scheduled: "Matching cleaner",
  accepted: "Cleaner assigned",
  cleaning: "Cleaning",
  done: "Done",
  canceled: "Canceled",
};

export function stageIndex(stage: VisitStage): number {
  return STAGES.indexOf(stage);
}

export function isStageReached(stage: VisitStage, current: VisitStage): boolean {
  return current !== "canceled" && stage !== "canceled" && stageIndex(stage) <= stageIndex(current);
}

export interface VisitSummary {
  stage: VisitStage;
  scheduledStart: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  expectedFinishAt: Date | null;
  roomsDone: number;
  roomsTotal: number;
}

/**
 * The sentence under the heading.
 *
 * Written per stage rather than assembled from fragments, because this is the
 * line somebody reads while a stranger is in their kitchen and it has to sound
 * like a person wrote it.
 */
export function visitHeadline(visit: VisitSummary, cleanerFirstName: string | null): string {
  const who = cleanerFirstName ?? "Your cleaner";

  switch (visit.stage) {
    case "canceled":
      return "This visit was canceled";
    case "done":
      return `${who} has finished`;
    case "cleaning":
      return `${who} is cleaning now`;
    case "accepted":
      return `${who} is booked in`;
    case "scheduled":
      return "We are matching you with a cleaner";
  }
}

/**
 * How far through, for the progress bar.
 *
 * Rooms rather than elapsed time. A clock-based bar claims to know how long
 * this house takes, and the estimate is ours — a bar at 90% while she is still
 * on the second bathroom is worse than no bar. Rooms are counted from required before/after server photo pairs.
 * Finished work can still have photos waiting to upload.
 */
export function roomProgress(visit: VisitSummary): number | null {
  if (visit.stage !== "cleaning" && visit.stage !== "done") return null;
  if (visit.roomsTotal <= 0) return null;

  if (!Number.isSafeInteger(visit.roomsDone) || visit.roomsDone < 0 || !Number.isSafeInteger(visit.roomsTotal)) return null;
  return Math.min(1, visit.roomsDone / visit.roomsTotal);
}

/** Cancellation and completion take precedence over historical timestamps. */
export function visitStage(status: string, startedAt: Date | null, hasAssignment: boolean): VisitStage {
  if (!["unscheduled", "scheduled", "dispatching", "assigned", "in_progress", "complete", "canceled"].includes(status)) {
    throw new Error("Your visit status could not be verified. Please refresh.");
  }
  if (status === "canceled") return "canceled";
  if (status === "complete") return "done";
  if (status === "in_progress" || startedAt) return "cleaning";
  if (hasAssignment || status === "assigned") return "accepted";
  if (["unscheduled", "scheduled", "dispatching"].includes(status)) return "scheduled";
  throw new Error("Your visit status could not be verified. Please refresh.");
}
