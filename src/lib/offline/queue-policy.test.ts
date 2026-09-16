import { describe, expect, it } from "vitest";
import {
  ATTEMPTS_BEFORE_WARNING,
  MAX_BACKOFF_MS,
  STALLED_AFTER_MS,
  afterFailure,
  backoffMs,
  beginUpload,
  nextToUpload,
  recoverStalled,
  storagePathFor,
  summarise,
  type QueueItem,
} from "./queue-policy";

/**
 * "A checklist that discards photos when the connection drops is one nobody
 * uses twice." These are that sentence, as assertions.
 */

const NOW = 1_700_000_000_000;

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "q1",
    jobId: "job-1",
    roomKey: "kitchen_1",
    kind: "before",
    takenAt: NOW,
    state: "pending",
    attempts: 0,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

describe("a failure never loses the photo", () => {
  it("keeps the item and only moves its schedule", () => {
    const failed = afterFailure(item(), NOW, "network down");
    expect(failed.state).toBe("pending");
    expect(failed.id).toBe("q1");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("never stops retrying, however many times it has failed", () => {
    // Not a give-up threshold. A queue that bins work after N tries is the
    // thing this design exists to prevent.
    let current = item();
    for (let i = 0; i < 50; i++) current = afterFailure(current, NOW, "still down");

    expect(current.state).toBe("pending");
    expect(nextToUpload([{ ...current, nextAttemptAt: NOW }], NOW, true)).not.toBeNull();
  });

  it("records why, truncated, so a screen can say something useful", () => {
    const failed = afterFailure(item(), NOW, "x".repeat(500));
    expect(failed.lastError).toHaveLength(200);
  });
});

describe("backoff", () => {
  it("grows and then stops growing", () => {
    const noJitter = () => 0.5;
    expect(backoffMs(1, noJitter)).toBe(2_000);
    expect(backoffMs(2, noJitter)).toBe(4_000);
    expect(backoffMs(3, noJitter)).toBe(8_000);
    expect(backoffMs(50, noJitter)).toBe(MAX_BACKOFF_MS);
  });

  it("is jittered, so a van full of phones does not retry in lockstep", () => {
    // Twenty simultaneous uploads on recovering LTE is how one dropped
    // connection becomes twenty.
    const low = backoffMs(4, () => 0);
    const high = backoffMs(4, () => 1);
    expect(low).toBeLessThan(high);
    expect(high - low).toBeGreaterThan(0);
  });

  it("never returns a negative delay", () => {
    expect(backoffMs(1, () => 0)).toBeGreaterThanOrEqual(0);
    expect(backoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("what to send next", () => {
  it("sends nothing while offline", () => {
    expect(nextToUpload([item()], NOW, false)).toBeNull();
  });

  it("sends the oldest photo first", () => {
    // The ones waiting longest are the most at risk of a cleared cache, and
    // draining in order leaves whole rooms done rather than a scatter.
    const chosen = nextToUpload(
      [item({ id: "new", takenAt: NOW + 5000 }), item({ id: "old", takenAt: NOW - 5000 })],
      NOW,
      true,
    );
    expect(chosen?.id).toBe("old");
  });

  it("respects the backoff it was given", () => {
    expect(nextToUpload([item({ nextAttemptAt: NOW + 1000 })], NOW, true)).toBeNull();
    expect(nextToUpload([item({ nextAttemptAt: NOW })], NOW, true)).not.toBeNull();
  });

  it("does not pick up something already in flight", () => {
    expect(nextToUpload([item({ state: "uploading" })], NOW, true)).toBeNull();
  });

  it("does not pick up something finished", () => {
    expect(nextToUpload([item({ state: "done" })], NOW, true)).toBeNull();
  });
});

describe("a tab closed mid-upload", () => {
  it("puts a stalled item back rather than stopping the queue for ever", () => {
    // A phone that goes into a tunnel mid-PUT leaves a row nobody will settle.
    // Without this the queue halts on one item and the rest never uploads.
    const stuck = beginUpload(item());
    const started = new Map([[stuck.id, NOW - STALLED_AFTER_MS - 1]]);

    const recovered = recoverStalled([stuck], NOW, started);
    expect(recovered[0]?.state).toBe("pending");
    expect(nextToUpload(recovered, NOW, true)).not.toBeNull();
  });

  it("leaves a genuinely in-flight upload alone", () => {
    const inFlight = beginUpload(item());
    const started = new Map([[inFlight.id, NOW - 1000]]);
    expect(recoverStalled([inFlight], NOW, started)[0]?.state).toBe("uploading");
  });

  it("recovers an item with no start time at all, which is the crash case", () => {
    // The row survived a process that did not. It must not sit there for ever.
    const orphan = beginUpload(item());
    expect(recoverStalled([orphan], NOW, new Map())[0]?.state).toBe("pending");
  });
});

describe("what the cleaner is told", () => {
  it("is busy while anything is outstanding", () => {
    expect(summarise([item()]).busy).toBe(true);
    expect(summarise([item({ state: "done" })]).busy).toBe(false);
  });

  it("flags items that have failed enough to be worth mentioning", () => {
    // A cleaner who believes her photos uploaded and finds out on Friday that
    // they did not is the failure this whole design exists to avoid.
    const struggling = item({ attempts: ATTEMPTS_BEFORE_WARNING });
    expect(summarise([struggling]).struggling).toBe(1);
    expect(summarise([item({ attempts: 1 })]).struggling).toBe(0);
  });

  it("does not count a finished item as struggling, however hard it was", () => {
    expect(summarise([item({ state: "done", attempts: 20 })]).struggling).toBe(0);
  });
});

describe("storage paths", () => {
  it("are derived, so a retry overwrites rather than orphaning", () => {
    // An upload that succeeded but whose response was lost costs one wasted
    // PUT and nothing else.
    expect(storagePathFor("job-1", "kitchen_1", "before")).toBe(
      storagePathFor("job-1", "kitchen_1", "before"),
    );
  });

  it("separate every job, room and kind", () => {
    const paths = new Set([
      storagePathFor("job-1", "kitchen_1", "before"),
      storagePathFor("job-1", "kitchen_1", "after"),
      storagePathFor("job-1", "bedroom_1", "before"),
      storagePathFor("job-2", "kitchen_1", "before"),
    ]);
    expect(paths.size).toBe(4);
  });
});
