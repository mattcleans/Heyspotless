import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import * as store from "./photo-store";
import { drain } from "./drain";
import {
  listWork,
  saveWork,
  setWorkOwner,
} from "../../../public/offline-work.js";

const { upload, getUser } = vi.hoisted(() => ({
  upload: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../supabase/client", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload }) },
    auth: { getUser },
  }),
}));
function photo(overrides: Partial<store.StoredPhoto> = {}): store.StoredPhoto {
  return {
    id: "job:kitchen:before",
    jobId: "job",
    roomKey: "kitchen",
    kind: "before",
    takenAt: 1000,
    revision: "original",
    state: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    blob: new Blob(["original"]),
    ...overrides,
  };
}
const recorded = () =>
  Promise.resolve(
    new Response(JSON.stringify({ recorded: true }), { status: 200 }),
  );
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn(recorded));
  upload.mockReset().mockResolvedValue({ error: null });
  getUser.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("upload settlement", () => {
  it("does not send an owned capture using another cleaner's authenticated session", async () => {
    const ownerId = "e1100000-0000-0000-0000-000000000001";
    await setWorkOwner(ownerId);
    await store.enqueue(photo({ ownerId }));
    getUser.mockResolvedValue({ data: { user: { id: "other" } }, error: null });
    const summary = vi.fn();
    await drain(summary, "job");
    expect(upload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.listOutstanding()).toHaveLength(1);
    expect(summary.mock.lastCall?.[0].authRequired).toBe(true);
  });
  it("keeps server-confirmed checklist markers after the correct owner's queue drains", async () => {
    const ownerId = "e1100000-0000-0000-0000-000000000001";
    const jobId = "e1500000-0000-0000-0000-000000000001";
    await setWorkOwner(ownerId);
    await saveWork({
      ownerId,
      jobId,
      status: "in_progress",
      checkedAt: Date.now(),
      scheduledAt: null,
      rooms: [{ key: "kitchen_1", label: "Kitchen" }],
      confirmed: [],
    });
    await store.enqueue(
      photo({
        id: `${jobId}:kitchen_1:before`,
        jobId,
        roomKey: "kitchen_1",
        ownerId,
      }),
    );
    getUser.mockResolvedValue({ data: { user: { id: ownerId } }, error: null });
    await drain();
    expect(upload).toHaveBeenCalledOnce();
    expect(await store.listOutstanding()).toEqual([]);
    expect((await listWork())[0]?.confirmed).toEqual([
      { roomKey: "kitchen_1", kind: "before" },
    ]);
  });
  it("shows session recovery when storage rejects an expired login", async () => {
    upload.mockResolvedValue({
      error: { message: "expired", statusCode: "401" },
    });
    await store.enqueue(photo());
    const summary = vi.fn();
    await drain(summary, "job");
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.listOutstanding()).toHaveLength(1);
    expect(summary.mock.lastCall?.[0].authRequired).toBe(true);
  });

  it("uses a browser lock for upload passes when available", async () => {
    const request = vi.fn(async (_name: string, work: () => Promise<void>) =>
      work(),
    );
    vi.stubGlobal("navigator", { onLine: true, locks: { request } });
    await store.enqueue(photo());
    await drain();
    expect(request).toHaveBeenCalledWith(
      "spotless-photo-upload",
      expect.any(Function),
    );
    expect(await store.listOutstanding()).toEqual([]);
  });

  it("removes the committed copy only after storage and recording both confirm it", async () => {
    await store.enqueue(photo());
    await drain();
    expect(upload).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await store.listOutstanding()).toEqual([]);
  });

  it.each([401, 500])(
    "keeps photos when recording returns %s",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response("{}", { status }));
      await store.enqueue(photo());
      const summary = vi.fn();
      await drain(summary, "job");
      const [saved] = await store.listOutstanding();
      expect(saved?.attempts).toBe(1);
      expect(saved?.lastError).toBe(`record: ${status}`);
      expect(await saved?.blob.text()).toBe("original");
      expect(summary.mock.lastCall?.[0].authRequired).toBe(status === 401);
    },
  );

  it.each(["{}", "<html>Sign in</html>"])(
    "keeps photos after an unconfirmed successful response %s",
    async (body) => {
      vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));
      await store.enqueue(photo());
      await drain();
      expect(await store.listOutstanding()).toHaveLength(1);
    },
  );

  it("keeps the retake if an earlier upload finishes while it is being captured", async () => {
    let release!: (value: { error: null }) => void;
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await store.enqueue(photo());
    const pass = drain();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await store.enqueue(
      photo({ revision: "retake", blob: new Blob(["retake"]) }),
    );
    upload.mockResolvedValue({ error: { message: "no connection" } });
    release({ error: null });
    await pass;
    const [saved] = await store.listOutstanding();
    expect(saved?.revision).toBe("retake");
    expect(await saved?.blob.text()).toBe("retake");
    expect(saved?.attempts).toBe(1);
  });

  it("notifies both mounted callers without starting duplicate uploads", async () => {
    let release!: (value: { error: null }) => void;
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await store.enqueue(photo());
    const first = vi.fn();
    const second = vi.fn();
    const pass = drain(first, "job");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const joined = drain(second, "job");
    release({ error: null });
    await Promise.all([pass, joined]);
    expect(upload).toHaveBeenCalledOnce();
    expect(first.mock.lastCall?.[0].outstanding).toBe(0);
    expect(second.mock.lastCall?.[0].outstanding).toBe(0);
  });

  it("manual retry makes only this visit's pending photos immediately eligible", async () => {
    const future = Date.now() + 100000;
    await store.enqueue(photo({ nextAttemptAt: future, attempts: 4 }));
    await store.enqueue(
      photo({
        id: "other:kitchen:before",
        jobId: "other",
        nextAttemptAt: future,
      }),
    );
    const summary = vi.fn();
    await drain(summary, "job", true);
    expect(upload).toHaveBeenCalledOnce();
    expect((await store.listOutstanding()).map((p) => p.jobId)).toEqual([
      "other",
    ]);
    expect(summary.mock.lastCall?.[0].outstanding).toBe(0);
  });

  it("releases a failed pass so a later attempt can recover", async () => {
    const read = vi
      .spyOn(store, "listOutstanding")
      .mockRejectedValueOnce(new Error("storage failed"));
    await expect(drain()).rejects.toThrow("storage failed");
    read.mockRestore();
    await store.enqueue(photo());
    await drain();
    expect(await store.listOutstanding()).toEqual([]);
  });
});
