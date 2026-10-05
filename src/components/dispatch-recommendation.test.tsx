import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DispatchRecommendation } from "./dispatch-recommendation";
import type { DispatchDecision } from "@/lib/dispatch/engine";
import { contractor, iggy, shonda } from "@/lib/dispatch/fixtures";

const now = new Date("2026-10-05T00:00:00Z");
const none = { status: "none", reason: "no_relationship" } as const;
const render = (decision: DispatchDecision) => renderToStaticMarkup(
  <DispatchRecommendation decision={decision} priceCents={19900} now={now} />,
);
describe("Management matching recommendations", () => {
  it("distinguishes zero additional employee cost from employee pay", () => {
    const html = render({ kind: "assign_guaranteed", cleaner: shonda(), marginalCents: 0, unspentHoursBefore: 20, continuity: none, rationale: "already assigned, $0 to cleaner" });
    expect(html).toContain("Consider Shonda");
    expect(html).toContain("Estimated additional cost");
    expect(html).toContain("$0.00");
    expect(html).toContain("Employee wages follow their hourly terms");
    expect(html).not.toContain("to cleaner");
    expect(html).not.toContain("already assigned");
  });
  it("labels employee fallback cost as an estimate rather than agreed payout", () => {
    const html = render({ kind: "assign_w2", cleaner: iggy(), marginalCents: 4800, continuity: none, rationale: "assigned" });
    expect(html).toContain("Consider Iggy");
    expect(html).toContain("Estimated additional cost");
    expect(html).toContain("$48.00");
    expect(html).not.toContain("Proposed contractor pay");
  });
  it("does not present a calculated exclusive window as a saved hold or deadline", () => {
    const cleaner = contractor();
    const html = render({ kind: "hold_for_incumbent", cleaner, basis: "preferred", payoutCents: 6965, share: .35, exclusiveUntil: new Date("2026-10-05T04:00:00Z"), fallback: "waterfall", continuity: { status: "held", cleanerId: cleaner.id, basis: "preferred", expiresAt: new Date("2026-10-05T04:00:00Z"), premiumCents: 0 }, rationale: "She has it to herself. Exclusive until Oct 5." });
    expect(html).toContain("Offer to Marketplace Cleaner first");
    expect(html).toContain("240");
    expect(html).toContain("after sending. A saved offer determines the actual deadline");
    expect(html).toContain("Proposed contractor pay");
    expect(html).not.toContain("Held for");
    expect(html).not.toContain("Exclusive until");
    expect(html).not.toContain("has it to herself");
  });
  it("describes an open offer as proposed rather than already posted", () => {
    const html = render({ kind: "open_board", payoutCents: 6965, share: .35, promoteToWaterfallAt: now, eligible: [contractor()], continuity: none, rationale: "Posted to all cleaners" });
    expect(html).toContain("Consider an open offer");
    expect(html).toContain("Review current availability before sending");
    expect(html).not.toContain("Posted to all cleaners");
  });
  it("requires Client approval when the plan recommends a backup", () => {
    const html = render({ kind: "assign_w2", cleaner: iggy(), marginalCents: 4800, continuity: { status: "waived_too_costly", cleanerId: "usual", basis: "preferred", premiumCents: 4000, capCents: 3000 }, rationale: "Substituting" });
    expect(html).toContain("Consider a backup");
    expect(html).toContain("client must approve the actual backup assignment before work starts");
    expect(html).not.toContain("Substituting");
  });
  it("does not imply timed offers or countdowns are already active", () => {
    const html = render({ kind: "waterfall", ladder: [], tiers: [], w2CeilingCents: null, w2Fallback: null, continuity: none, rationale: "Countdown active" });
    expect(html).toContain("Consider timed offers");
    expect(html).toContain("do not confirm that offers were sent or accepted");
    expect(html).not.toContain("Countdown active");
  });
  it("gives an actionable review when no cleaner is eligible", () => {
    const html = render({ kind: "no_eligible_cleaner", continuity: none, rationale: "None" });
    expect(html).toContain("No eligible cleaner in this plan");
    expect(html).toContain("Review cleaner availability and requirements");
  });
});
