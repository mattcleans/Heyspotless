import { describe, expect, it } from "vitest";
import { groupThreads, partyOf, type InboxMessage } from "./threads";

function message(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: crypto.randomUUID(),
    direction: "inbound",
    body: "hello",
    sentAt: new Date("2026-09-17T15:00:00Z"),
    readAt: null,
    kind: null,
    customerId: null,
    cleanerId: null,
    leadId: null,
    fromAddress: "+12145550143",
    toAddress: "+19725550100",
    ...over,
  };
}

describe("partyOf", () => {
  /**
   * The rule that decides whether an inbox is usable. An on-my-way text carries
   * a customer id AND the cleaner id of whoever sent it; filing it under the
   * cleaner scatters the customer's own conversation across two threads.
   */
  it("files a message with both ids under the customer", () => {
    const party = partyOf(message({ customerId: "cus-1", cleanerId: "cle-1" }));
    expect(party).toEqual({ kind: "customer", id: "cus-1" });
  });

  it("files a lead's message under the lead", () => {
    expect(partyOf(message({ leadId: "lead-1" }))).toEqual({ kind: "lead", id: "lead-1" });
  });

  it("files a cleaner-only message under the cleaner", () => {
    expect(partyOf(message({ cleanerId: "cle-1" }))).toEqual({ kind: "cleaner", id: "cle-1" });
  });

  /** The most important thread in the inbox: probably a new customer. */
  it("files an unattached message under the number it came from", () => {
    expect(partyOf(message())).toEqual({ kind: "unknown", id: "+12145550143" });
  });

  it("uses the destination number for an unattached outbound message", () => {
    expect(partyOf(message({ direction: "outbound" }))).toEqual({
      kind: "unknown",
      id: "+19725550100",
    });
  });
});

describe("groupThreads", () => {
  it("gathers one person's messages into one thread", () => {
    const threads = groupThreads([
      message({ customerId: "cus-1", body: "first" }),
      message({ customerId: "cus-1", body: "second", direction: "outbound" }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("reads a conversation oldest first", () => {
    const threads = groupThreads([
      message({ customerId: "cus-1", body: "later", sentAt: new Date("2026-09-17T18:00:00Z") }),
      message({ customerId: "cus-1", body: "earlier", sentAt: new Date("2026-09-17T09:00:00Z") }),
    ]);

    expect(threads[0]?.messages.map((m) => m.body)).toEqual(["earlier", "later"]);
  });

  it("counts only unanswered inbound messages as unread", () => {
    const threads = groupThreads([
      message({ customerId: "cus-1" }),
      message({ customerId: "cus-1", readAt: new Date() }),
      message({ customerId: "cus-1", direction: "outbound" }),
    ]);

    expect(threads[0]?.unread).toBe(1);
  });

  /**
   * An inbox sorted purely by time buries the one thing that needs answering
   * under six automated reminders that went out this evening.
   */
  it("puts threads with something unread above more recent quiet ones", () => {
    const threads = groupThreads([
      message({
        customerId: "quiet",
        customerName: "Quiet",
        direction: "outbound",
        sentAt: new Date("2026-09-17T20:00:00Z"),
      }),
      message({
        customerId: "waiting",
        customerName: "Waiting",
        sentAt: new Date("2026-09-17T11:00:00Z"),
      }),
    ]);

    expect(threads.map((t) => t.name)).toEqual(["Waiting", "Quiet"]);
  });

  it("orders quiet threads by recency", () => {
    const threads = groupThreads([
      message({
        customerId: "older",
        customerName: "Older",
        direction: "outbound",
        sentAt: new Date("2026-09-16T10:00:00Z"),
      }),
      message({
        customerId: "newer",
        customerName: "Newer",
        direction: "outbound",
        sentAt: new Date("2026-09-17T10:00:00Z"),
      }),
    ]);

    expect(threads.map((t) => t.name)).toEqual(["Newer", "Older"]);
  });

  it("keeps a stranger's number as the thread's name until somebody is attached", () => {
    const threads = groupThreads([message()]);
    expect(threads[0]?.name).toContain("+12145550143");
    expect(threads[0]?.phone).toBe("+12145550143");
  });

  it("takes a name from whichever message in the thread has one", () => {
    const threads = groupThreads([
      message({ customerId: "cus-1", customerName: null }),
      message({ customerId: "cus-1", customerName: "Dana Reyes", direction: "outbound" }),
    ]);

    expect(threads[0]?.name).toBe("Customer");
  });

  it("keeps a cleaner's thread separate from a customer's", () => {
    const threads = groupThreads([
      message({ customerId: "cus-1" }),
      message({ cleanerId: "cle-1" }),
    ]);

    expect(threads).toHaveLength(2);
  });
});
