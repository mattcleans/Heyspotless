import { describe, expect, it } from "vitest";
import { outcomeForFailedSend } from "./retry";

/**
 * The production failure this was written for, on 19 September:
 *
 *   {"due":2,"sent":0,"failed":2,"problems":[
 *     {"error":"Twilio is not configured. Set TWILIO_ACCOUNT_SID, …"}]}
 *
 * Every hour, for something no retry could fix.
 */

describe("outcomeForFailedSend", () => {
  it("settles a failure the provider will repeat, rather than releasing it", () => {
    const outcome = outcomeForFailedSend(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and …",
      false,
    );

    expect(outcome.kind).toBe("skipped");
    // The reason stays on the row: "why did this customer get no reminder" has
    // an answer, and it is not "nobody tried".
    expect(outcome.reason).toContain("Twilio is not configured");
    expect(outcome.reason).toContain("not retryable");
  });

  it("releases a failure that might genuinely be different next time", () => {
    const outcome = outcomeForFailedSend("503: service unavailable", true);

    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toBe("503: service unavailable");
  });

  /**
   * The two classes as the gateway produces them. A 4xx is ours and will fail
   * identically; a 5xx, a 429 or a timeout is the provider's.
   */
  it("matches the gateway's own classification", () => {
    const providerFault = ["500: internal", "502: bad gateway", "429: too many requests"];
    for (const reason of providerFault) {
      expect(outcomeForFailedSend(reason, true).kind).toBe("failed");
    }

    const ourFault = [
      "400: 'To' number is not a valid phone number",
      "403: the message sender is not registered",
      "messaging is disabled",
    ];
    for (const reason of ourFault) {
      expect(outcomeForFailedSend(reason, false).kind).toBe("skipped");
    }
  });

  /**
   * A skipped send is counted as fired, so it stops. That is the whole point:
   * an alert that repeats every hour for something nobody can act on from the
   * alert is one people learn to close.
   */
  it("never asks for a retry it has already ruled out", () => {
    expect(outcomeForFailedSend("anything", false).kind).not.toBe("failed");
  });
});
