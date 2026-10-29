import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { JobFlow } from "./job-flow";
describe("unknown visit room list", () => {
  it("keeps Done available without presenting an empty photo checklist as complete", () => {
    const html = renderToStaticMarkup(createElement(JobFlow, { jobId: "job", initialStatus: "in_progress", rooms: [], alreadyDone: [], roomScopeAvailable: false }));
    expect(html).toContain("You can still finish the visit");expect(html).toContain(">Done</button>");expect(html).not.toContain("All rooms done");
  });
});
