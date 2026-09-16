import { describe, expect, it } from "vitest";
import { offerAcceptedMessage, offerMessage, offerWithdrawnMessage } from "./templates";
import { reachabilityOf } from "./store";

const base = {
  cleanerFirstName: "Marisol",
  customerName: "Ann Lutich",
  street: "781 Ohio Dr",
  city: "Plano",
  payoutCents: 5610,
  scheduledStart: new Date("2026-09-22T14:30:00Z"),
  expiresAt: new Date("2026-09-15T20:00:00Z"),
  offerUrl: "https://app.heyspotless.com/cleaner",
};

describe("the offer text", () => {
  it("names a price, never a rate", () => {
    // The platform pays per clean. Quoting an hourly figure is a different
    // business, and one with a worker-classification problem attached.
    const body = offerMessage({ ...base, isExclusive: false });
    expect(body).toContain("$56.10");
    expect(body).not.toMatch(/\/hr|per hour|an hour/i);
  });

  it("leaks nothing about the ladder", () => {
    // A cleaner who learns the offer improves if she waits will wait, which
    // drifts every payout to the ceiling and costs the whole benefit of
    // escalating.
    const body = offerMessage({ ...base, isExclusive: false });
    expect(body).not.toMatch(/rung|tier|ceiling|increase|may go up|escalat/i);
  });

  it("says when it runs out", () => {
    // A countdown she cannot see is one she will lose, and losing one she was
    // never shown is how a good cleaner stops answering.
    const body = offerMessage({ ...base, isExclusive: false });
    expect(body).toMatch(/Closes/);
  });

  it("tells her when a job is being held for her, because that part is hers", () => {
    const exclusive = offerMessage({ ...base, isExclusive: true });
    expect(exclusive).toContain("your customer");
    expect(exclusive).toMatch(/Held for you/);

    const open = offerMessage({ ...base, isExclusive: false });
    expect(open).not.toMatch(/Held for you/);
    expect(open).toMatch(/First to accept/);
  });

  it("carries an opt-out, which A2P requires on recurring traffic", () => {
    for (const body of [
      offerMessage({ ...base, isExclusive: true }),
      offerWithdrawnMessage(base),
      offerAcceptedMessage(base),
    ]) {
      expect(body).toContain("Reply STOP");
    }
  });

  it("handles a job with no date rather than printing a broken one", () => {
    const body = offerMessage({ ...base, scheduledStart: null, isExclusive: false });
    expect(body).toContain("date to be confirmed");
    expect(body).not.toContain("Invalid");
  });

  it("stays inside two SMS segments", () => {
    // Not a hard limit, but every segment is billed and a five-part text reads
    // as spam on a phone.
    const body = offerMessage({ ...base, isExclusive: true });
    expect(body.length).toBeLessThan(320);
  });
});

describe("the withdrawal text", () => {
  it("says plainly that it does not count against her", () => {
    // Losing a race is not declining work. Acceptance rate drives ranking, and
    // a cleaner who thinks otherwise stops answering fast.
    const body = offerWithdrawnMessage(base);
    expect(body).toMatch(/does not count against/i);
  });
});

describe("reachability", () => {
  const recipient = {
    cleanerId: "c-1",
    profileId: "p-1",
    firstName: "Marisol",
    phone: "+12145550100",
    optedOut: false,
  };

  it("is reachable with a number and no opt-out", () => {
    const result = reachabilityOf(recipient);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.phone).toBe("+12145550100");
  });

  it("is not reachable after STOP", () => {
    const result = reachabilityOf({ ...recipient, optedOut: true });
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.reason).toBe("opted_out");
  });

  it("is not reachable with no number on file", () => {
    const result = reachabilityOf({ ...recipient, phone: null });
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.reason).toBe("no_phone");
  });

  it("is not reachable when the cleaner is unknown", () => {
    const result = reachabilityOf(undefined);
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.reason).toBe("unknown_cleaner");
  });
});
