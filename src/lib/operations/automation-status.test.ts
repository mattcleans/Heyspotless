import { expect, it } from "vitest";
import { automationState, type AutomationRecord } from "./automation-status";
const now = new Date("2026-09-23T17:00:00Z");
const record = (changes: Partial<AutomationRecord> = {}): AutomationRecord => ({
  id: "a",
  outcome: null,
  error: null,
  fired_at: null,
  scheduled_for: "2026-09-23T15:00:00Z",
  ...changes,
});
it("flags overdue unfired messages after a full scheduler window", () =>
  expect(automationState(record(), now)).toBe("overdue"));
it("does not alarm on a recently due message", () =>
  expect(
    automationState(record({ scheduled_for: "2026-09-23T16:30:00Z" }), now),
  ).toBe("waiting"));
it("surfaces a permanently stopped send even when its outcome was skipped", () =>
  expect(
    automationState(
      record({
        outcome: "skipped",
        error: "not retryable: delivery unavailable",
        fired_at: now.toISOString(),
      }),
      now,
    ),
  ).toBe("stopped"));
it("does not flag an intentional consent skip", () =>
  expect(
    automationState(
      record({
        outcome: "skipped",
        error: "customer opted out",
        fired_at: now.toISOString(),
      }),
      now,
    ),
  ).toBe("skipped"));
it("distinguishes a sent message from pending work", () =>
  expect(
    automationState(
      record({ outcome: "sent", fired_at: now.toISOString() }),
      now,
    ),
  ).toBe("sent"));
it("surfaces a retryable failed message", () =>
  expect(
    automationState(
      record({ outcome: "failed", error: "temporary provider issue" }),
      now,
    ),
  ).toBe("stopped"));
