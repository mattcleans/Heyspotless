/**
 * When to try an upload again, and when to stop pretending it is fine.
 *
 * "A checklist that discards photos when the connection drops is one nobody
 * uses twice" — build plan, phase 4. That sentence is the whole specification
 * for this file and the one next to it, so the rules are written down rather
 * than left implicit in a retry loop:
 *
 *   1. A PHOTO IS DURABLE BEFORE IT IS SENT. The bytes land in IndexedDB
 *      before any network call happens. If the app is killed a millisecond
 *      later, the photo is still there.
 *   2. NOTHING IS DELETED UNTIL THE SERVER CONFIRMS IT. Not on error, not on
 *      timeout, not on a 500. The only thing that removes a photo from the
 *      queue is the server saying it has it.
 *   3. THE QUEUE NEVER GIVES UP. It backs off, and past a point it stops
 *      looking busy and tells her something is wrong — but it keeps trying,
 *      because the alternative is silently binning an hour of her work.
 *
 * Pure and deterministic, so all of that is assertable in a test runner with
 * no browser, no network and no clock.
 */

export type QueueItemState = "pending" | "uploading" | "done";

export interface QueueItem {
  id: string;
  jobId: string;
  roomKey: string;
  kind: "before" | "after" | "issue";
  takenAt: number;
  state: QueueItemState;
  attempts: number;
  /** When it may next be tried. Epoch ms. */
  nextAttemptAt: number;
  lastError?: string;
}

/** First retry after 2s, doubling, capped — the cap matters more than the curve. */
export const BASE_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Attempts before the queue stops looking like it is working and says so.
 *
 * NOT a give-up threshold. It keeps retrying afterwards at the capped
 * interval; what changes is that the screen stops implying everything is fine.
 * A cleaner who thinks her photos uploaded and finds out on Friday that they
 * did not is the failure this whole design exists to avoid.
 */
export const ATTEMPTS_BEFORE_WARNING = 4;

/**
 * Backoff with jitter.
 *
 * Jittered because a van full of photos regaining signal at the same moment
 * would otherwise retry in lockstep, and twenty simultaneous uploads on
 * recovering LTE is how you turn one dropped connection into twenty.
 */
export function backoffMs(attempts: number, rng: () => number = Math.random): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  // ±25%, so the spread is real without the first retry taking minutes.
  const jitter = exponential * 0.25 * (rng() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/**
 * The next item to attempt, or null.
 *
 * Oldest first, deliberately: the photos most at risk of being lost to a
 * cleared cache or a reinstalled app are the ones that have been waiting
 * longest. It also means a job finishes uploading in the order it was shot,
 * so a partially-drained queue leaves whole rooms done rather than a scatter.
 */
export function nextToUpload(
  items: readonly QueueItem[],
  now: number,
  online: boolean,
): QueueItem | null {
  if (!online) return null;

  const ready = items
    .filter((i) => i.state === "pending" && i.nextAttemptAt <= now)
    .sort((a, b) => a.takenAt - b.takenAt);

  return ready[0] ?? null;
}

/** An upload failed. The item stays; only its schedule changes. */
export function afterFailure(
  item: QueueItem,
  now: number,
  error: string,
  rng: () => number = Math.random,
): QueueItem {
  const attempts = item.attempts + 1;
  return {
    ...item,
    state: "pending",
    attempts,
    nextAttemptAt: now + backoffMs(attempts, rng),
    lastError: error.slice(0, 200),
  };
}

/**
 * Mark an item in flight.
 *
 * Its own state rather than a flag, so a tab closed mid-upload leaves a row
 * that is visibly stuck rather than one that looks finished. `recoverStalled`
 * puts those back.
 */
export function beginUpload(item: QueueItem): QueueItem {
  return { ...item, state: "uploading" };
}

/**
 * How long an upload may claim to be in flight before it is assumed dead.
 *
 * A phone that goes into a tunnel mid-PUT leaves an `uploading` row nobody
 * will ever settle. Without this the queue stops for ever on one item and the
 * rest of the job never uploads.
 */
export const STALLED_AFTER_MS = 2 * 60_000;

export function recoverStalled(
  items: readonly QueueItem[],
  now: number,
  startedAt: ReadonlyMap<string, number>,
): QueueItem[] {
  return items.map((item) => {
    if (item.state !== "uploading") return item;
    const since = startedAt.get(item.id);
    if (since !== undefined && now - since < STALLED_AFTER_MS) return item;
    return { ...item, state: "pending", nextAttemptAt: now };
  });
}

export interface QueueSummary {
  outstanding: number;
  /** Items that have failed enough times to be worth telling her about. */
  struggling: number;
  /** True while anything is still waiting to reach the server. */
  busy: boolean;
}

export function summarise(items: readonly QueueItem[]): QueueSummary {
  const outstanding = items.filter((i) => i.state !== "done").length;
  return {
    outstanding,
    struggling: items.filter(
      (i) => i.state !== "done" && i.attempts >= ATTEMPTS_BEFORE_WARNING,
    ).length,
    busy: outstanding > 0,
  };
}

/**
 * Where a photo lives in storage.
 *
 * Derived rather than random, so a retry after an ambiguous failure overwrites
 * the same object instead of leaving an orphan. Combined with
 * `record_job_photo` being idempotent per (job, room, kind), an upload that
 * succeeded but whose response was lost costs one wasted PUT and nothing else.
 */
export function storagePathFor(jobId: string, roomKey: string, kind: string): string {
  return `jobs/${jobId}/${roomKey}-${kind}.jpg`;
}
