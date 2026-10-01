import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { CleanerChoiceForm } from "./cleaner-choice-form";
import type { VisitChoice } from "@/lib/customer/cleaner-choice/store";
const choice: VisitChoice = {
  status: "assigned",
  started: false,
  preferredCleanerId: "preferred",
  assigned: { id: "assignment", cleanerId: "backup", name: "Backup" },
  request: {
    id: "request",
    cleanerId: "preferred",
    cleanerName: "Preferred",
    status: "applied",
    note: "Please keep my usual cleaner",
    decisionNote: "Preference applied",
  },
  backup: {
    assignmentId: "assignment",
    preferredCleanerId: "preferred",
    backupCleanerId: "backup",
    preferredName: "Preferred",
    backupName: "Backup",
    approved: false,
    decisionId: null,
    unambiguous: true,
  },
};
const render = (over: Partial<VisitChoice> = {}, preview = false) =>
  renderToStaticMarkup(
    createElement(CleanerChoiceForm, {
      jobId: "visit",
      choice: { ...choice, ...over },
      people: [{ id: "preferred", name: "Preferred" }],
      preview,
    }),
  );
describe("honest client cleaner controls", () => {
  it("distinguishes preference applied from requested cleaner acceptance", () => {
    expect(render()).toContain(
      "does not confirm that the requested cleaner has accepted",
    );
    expect(render()).toContain("Please keep my usual cleaner");
  });
  it("requires explicit backup approval and offers a different cleaner", () => {
    const html = render();
    expect(html).toContain("cannot start work until you approve");
    expect(html).toContain("Approve this backup");
    expect(html).toContain("Ask for a different cleaner");
  });
  it("persists the client's decline as a distinct current state", () => {
    const html = render({
      backup: { ...choice.backup!, decisionId: "decline" },
    });
    expect(html).toContain("You asked for a different cleaner");
    expect(html).toContain("Approve this backup instead");
  });
  it("does not imply approval carries to another assignment", () => {
    const html = render({
      backup: { ...choice.backup!, approved: true, decisionId: "approved" },
    });
    expect(html).toContain("A different cleaner will need a new approval");
  });
  it.each(["in_progress", "complete", "canceled"])(
    "closes choices for %s",
    (status) => {
      const html = render({ status });
      expect(html).toContain("Cleaner choices are closed");
      expect(html).not.toContain("Send preference request");
      expect(html).not.toContain("Ask for a different cleaner</button>");
    },
  );
  it("blocks choice when work already started despite stale assigned status", () => {
    expect(render({ started: true })).not.toContain("Send preference request");
  });
  it("does not render approval actions for an ambiguous lead", () => {
    const html = render({ backup: { ...choice.backup!, unambiguous: false } });
    expect(html).toContain("assignment needs office review");
    expect(html).not.toContain("Approve this backup</button>");
  });
  it("disables sample changes and labels them", () => {
    const html = render({}, true);
    expect(html).toContain("cannot be saved in preview mode");
    expect(html).toMatch(/disabled=""[^>]*>Approve this backup/);
  });
  it("provides recovery for an empty published directory", () => {
    const html = renderToStaticMarkup(
      createElement(CleanerChoiceForm, { jobId: "visit", choice, people: [] }),
    );
    expect(html).toContain("No published profiles were found");
    expect(html).toMatch(/disabled=""[^>]*>Send preference request/);
  });
});
