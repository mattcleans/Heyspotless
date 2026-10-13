import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  listWork,
  saveWork,
  saveWorkPhoto,
  setWorkOwner,
} from "../../../public/offline-work.js";
import { listForJob } from "./photo-store";

const owner = "e1100000-0000-0000-0000-000000000001";
const job = "e1500000-0000-0000-0000-000000000001";
const script = readFileSync(
  new URL("../../../public/sw.js", import.meta.url),
  "utf8",
);
type FetchEvent = {
  request: { url: string; method: string; mode: string };
  respondWith: (promise: Promise<Response>) => void;
};
function worker() {
  const handlers = new Map<string, (event: FetchEvent) => void>();
  const match = vi.fn(async () => new Response("Recovery checklist"));
  const fetch = vi.fn(async () => new Response("Live visit"));
  runInNewContext(script, {
    self: {
      location: { origin: "https://app.example.test" },
      addEventListener: (name: string, fn: (e: FetchEvent) => void) =>
        handlers.set(name, fn),
    },
    caches: { open: vi.fn(async () => ({ match })) },
    fetch,
    URL,
    Response,
    indexedDB,
  });
  async function navigate(path: string, method = "GET", mode = "navigate") {
    let result: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: {
        url: new URL(path, "https://app.example.test").href,
        method,
        mode,
      },
      respondWith: (p) => {
        result = p;
      },
    });
    return result;
  }
  return { navigate, fetch, match };
}
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("static recovery worker", () => {
  it.each([`/cleaner/job/${job}`, "/"])(
    "recovers a visit or installed-app cold navigation at %s",
    async (path) => {
      const { navigate, fetch, match } = worker();
      fetch.mockRejectedValue(new Error("No network"));
      expect(await (await navigate(path))!.text()).toBe("Recovery checklist");
      expect(match).toHaveBeenCalledWith("/offline-cleaner.html");
    },
  );
  it.each([401, 403, 500])(
    "never substitutes a cached checklist for HTTP %s",
    async (status) => {
      const { navigate, fetch, match } = worker();
      fetch.mockResolvedValue(new Response("Refused", { status }));
      expect((await navigate(`/cleaner/job/${job}`))?.status).toBe(status);
      expect(match).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["/api/jobs/start", "POST", "cors"],
    ["/api/cleaner/pending", "GET", "cors"],
    ["/cleaner", "GET", "cors"],
    ["/admin", "GET", "navigate"],
    ["/customer", "GET", "navigate"],
    ["https://other.example.test/cleaner", "GET", "navigate"],
  ])("does not cache or intercept %s", async (path, method, mode) => {
    const { navigate, fetch, match } = worker();
    expect(await navigate(path!, method, mode)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });
  it("clears checklist access before sign-out reaches the server, retaining queued bytes", async () => {
    await setWorkOwner(owner);
    await saveWork({
      ownerId: owner,
      jobId: job,
      status: "in_progress",
      checkedAt: Date.now(),
      scheduledAt: null,
      rooms: [{ key: "kitchen_1", label: "Kitchen" }],
      confirmed: [],
    });
    await saveWorkPhoto(job, owner, "kitchen_1", "before", new Blob(["keep"]));
    const { navigate, fetch } = worker();
    fetch.mockImplementation(async () => {
      expect(await listWork()).toEqual([]);
      return new Response("Signed out");
    });
    await navigate("/auth/sign-out", "POST");
    expect(fetch).toHaveBeenCalledOnce();
    expect(await (await listForJob(job))[0]!.blob.text()).toBe("keep");
  });
});
