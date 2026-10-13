import { describe, expect, it } from "vitest";
import {
  crewMessage,
  parseCrewAction,
  parseCrewAnswer,
  toCrewQuote,
  toCrewReceipt,
} from "./types";
import { crewResponse } from "./response";
const id = "c7600000-0000-0000-0000-000000000001";
const jobId = "c7500000-0000-0000-0000-000000000001";
export const receipt = {
  id,
  jobId,
  cleanerName: "Replacement",
  type: "contractor_1099",
  payoutCents: 8000,
  hourlyRateCents: null,
  start: "2028-01-03T15:00:00Z",
  minutes: 90,
  clientPriceCents: 24000,
  expiresAt: "2028-01-03T14:00:00Z",
  state: "sent",
  assignmentId: null,
  assignmentCurrent: false,
  clientApproved: false,
  needsClientApproval: true,
  city: "Dallas",
};
describe("crew replacement agreements and recovery", () => {
  it("reads own offer terms without requiring or copying the client price", () => {
    const { clientPriceCents: omitted, ...own } = receipt;
    expect(omitted).toBe(24000);
    expect(toCrewReceipt(own).payoutCents).toBe(8000);
    expect(toCrewReceipt(receipt)).not.toHaveProperty("clientPriceCents");
    expect(crewResponse(200, own, id).receipt?.payoutCents).toBe(8000);
  });
  it("never carries caller pay, identity or crew fields into a write", () => {
    expect(
      parseCrewAction({
        action: "quote",
        jobId,
        cleanerId: id,
        payoutCents: 999999,
        crew: [],
      }),
    ).toEqual({ action: "quote", jobId, cleanerId: id });
    expect(
      parseCrewAnswer({ id, accept: true, cleanerId: "other", payoutCents: 1 }),
    ).toEqual({ id, accept: true });
  });
  it.each([null, [], {}, { id, accept: "true" }, { id: "bad", accept: true }])(
    "rejects an invalid answer %j",
    (input) => expect(() => parseCrewAnswer(input)).toThrow(),
  );
  it.each([
    { payoutCents: -1 },
    { payoutCents: 0.5 },
    { state: "booked" },
    { assignmentId: id },
    { state: "accepted" },
    { needsClientApproval: "true" },
    { start: "bad" },
  ])("refuses malformed saved receipts %j", (patch) =>
    expect(() => toCrewReceipt({ ...receipt, ...patch })).toThrow(),
  );
  it("requires actual accepted identity before assignment success", () => {
    const r = toCrewReceipt({
      ...receipt,
      state: "accepted",
      assignmentId: id,
      assignmentCurrent: true,
    });
    expect(crewMessage(r)).toContain("client must approve");
    expect(crewMessage({ ...r, needsClientApproval: false })).toContain(
      "requested cleaner",
    );
  });
  it("never copies a contractor fee into an employee agreement", () => {
    expect(() =>
      toCrewReceipt({ ...receipt, type: "w2_core", hourlyRateCents: 2175 }),
    ).toThrow();
    expect(
      toCrewReceipt({
        ...receipt,
        state: "accepted",
        assignmentId: id,
        type: "w2_core",
        payoutCents: 0,
        hourlyRateCents: 2175,
      }).hourlyRateCents,
    ).toBe(2175);
  });
  it("requires the reviewed crew rather than reusing stale loaded teammates", () => {
    expect(() => toCrewQuote({ ...receipt, state: "review" })).toThrow();
    expect(() =>
      toCrewQuote({ ...receipt, state: "review", reviewCrew: [] }),
    ).toThrow();
    const quote = toCrewQuote({
      ...receipt,
      state: "review",
      reviewCrew: [
        {
          id,
          name: "Old lead",
          isLead: true,
          payoutCents: 8000,
          type: "contractor_1099",
        },
        {
          id: jobId,
          name: "Retained",
          isLead: false,
          payoutCents: 5100,
          type: "contractor_1099",
        },
      ],
    });
    expect(quote.reviewCrew).toHaveLength(2);
    expect(quote.clientPriceCents).toBe(24000);
    for (const clientPriceCents of [undefined, null, -1, "24000"])
      expect(() => toCrewQuote({ ...quote, clientPriceCents })).toThrow();
  });
  it.each([401, 403, 409, 500])(
    "does not accept a stale success payload on HTTP %i",
    (status) => {
      const r = crewResponse(
        status,
        {
          ...receipt,
          state: "accepted",
          assignmentId: id,
          assignmentCurrent: true,
        },
        id,
      );
      expect(r.receipt).toBeUndefined();
      expect(r.error).toBeTruthy();
    },
  );
  it("mismatched IDs and malformed JSON remain recoverable", () => {
    for (const body of [null, {}, { ...receipt, id: jobId }])
      expect(crewResponse(200, body, id).receipt).toBeUndefined();
  });
  it("shows sent as awaiting acceptance, not assigned or ready to start", () => {
    expect(crewMessage(toCrewReceipt(receipt))).toContain(
      "until the replacement accepts",
    );
    expect(crewResponse(200, receipt, id).receipt?.state).toBe("sent");
  });
});

it("keeps a historical acceptance separate from a current assignment or approval", () => {
  const r = toCrewReceipt({
    ...receipt,
    state: "accepted",
    assignmentId: id,
    assignmentCurrent: false,
  });
  expect(crewMessage(r)).toContain("does not confirm a current assignment");
  expect(
    crewMessage({ ...r, assignmentCurrent: true, clientApproved: true }),
  ).toContain("approved by the client");
});
