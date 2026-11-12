import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import * as store from "./photo-store";
import { drain } from "./drain";
import { CLIENT_REQUEST_TIMEOUT_MS } from "../http/fetch-with-timeout";
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
    jobId: "e1500000-0000-0000-0000-000000000001",
    roomKey: "kitchen_1",
    kind: "before",
    takenAt: 1000,
    revision: "a1111111-1111-4111-8111-111111111111",
    state: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    blob: new Blob(["original"]),
    ...overrides,
  };
}
const recorded = (_input: RequestInfo | URL, init?: RequestInit) =>
  Promise.resolve(
    new Response(JSON.stringify({ recorded: true, photoId: "a3333333-3333-4333-8333-333333333333", objectId: "a4444444-4444-4444-8444-444444444444", objectVersion: "v1", ...JSON.parse(String(init?.body ?? "{}")) }), { status: 200 }),
  );
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn(recorded));
  upload.mockReset().mockResolvedValue({ error: null });
  getUser.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("upload settlement", () => {
  it.each([0, 429, 503])("keeps an owned photo on session network failure %s without asking for sign-in", async (status) => {
    const ownerId = "e1100000-0000-0000-0000-000000000001";
    await setWorkOwner(ownerId);
    await store.enqueue(photo({ ownerId }));
    getUser.mockResolvedValue({ data: { user: null }, error: { status } });
    const summary = vi.fn();
    await drain(summary, "e1500000-0000-0000-0000-000000000001");
    expect(upload).not.toHaveBeenCalled();
    const [saved] = await store.listOutstanding();
    expect(saved?.lastError).toBe("session: unavailable");
    expect(await saved?.blob.text()).toBe("original");
    expect(summary.mock.lastCall?.[0].authRequired).toBe(false);
  });

  it("still requests sign-in for an expired session", async () => {
    const ownerId = "e1100000-0000-0000-0000-000000000001";
    await setWorkOwner(ownerId);
    await store.enqueue(photo({ ownerId }));
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    const summary = vi.fn();
    await drain(summary, "e1500000-0000-0000-0000-000000000001");
    expect(upload).not.toHaveBeenCalled();
    expect(await store.listOutstanding()).toHaveLength(1);
    expect(summary.mock.lastCall?.[0].authRequired).toBe(true);
  });

  it("retains photo bytes after a stalled recording request, then permits a fresh retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(fetch).mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await store.enqueue(photo());
    const summary = vi.fn();
    const pass = drain(summary, "e1500000-0000-0000-0000-000000000001");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
    await pass;
    const [saved] = await store.listOutstanding();
    expect(saved?.state).toBe("pending");
    expect(saved?.attempts).toBe(1);
    expect(saved?.lastError).toMatch(/timed out/i);
    expect(await saved?.blob.text()).toBe("original");
    expect(summary.mock.lastCall?.[0].outstanding).toBe(1);

    vi.mocked(fetch).mockImplementation(recorded);
    await drain(summary, "e1500000-0000-0000-0000-000000000001", true);
    expect(await store.listOutstanding()).toEqual([]);
    expect(summary.mock.lastCall?.[0].outstanding).toBe(0);
  });
  it("does not send an owned capture using another cleaner's authenticated session", async () => {
    const ownerId = "e1100000-0000-0000-0000-000000000001";
    await setWorkOwner(ownerId);
    await store.enqueue(photo({ ownerId }));
    getUser.mockResolvedValue({ data: { user: { id: "other" } }, error: null });
    const summary = vi.fn();
    await drain(summary, "e1500000-0000-0000-0000-000000000001");
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
      { roomKey: "kitchen_1", kind: "before", revision: "a1111111-1111-4111-8111-111111111111" },
    ]);
  });
  it("shows session recovery when storage rejects an expired login", async () => {
    upload.mockResolvedValue({
      error: { message: "expired", statusCode: "401" },
    });
    await store.enqueue(photo());
    const summary = vi.fn();
    await drain(summary, "e1500000-0000-0000-0000-000000000001");
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

  it.each([401, 409, 500])(
    "keeps photos when recording returns %s",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response("{}", { status }));
      await store.enqueue(photo());
      const summary = vi.fn();
      await drain(summary, "e1500000-0000-0000-0000-000000000001");
      const [saved] = await store.listOutstanding();
      expect(saved?.attempts).toBe(1);
      expect(saved?.lastError).toBe(`record: ${status}`);
      expect(await saved?.blob.text()).toBe("original");
      expect(summary.mock.lastCall?.[0].authRequired).toBe(status === 401);
    },
  );

  it.each(["{}", '{"recorded":true}', '{"recorded":true,"photoId":"wrong","jobId":"other"}', "<html>Sign in</html>"])(
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
      photo({ revision: "a2222222-2222-4222-8222-222222222222", blob: new Blob(["retake"]) }),
    );
    upload.mockResolvedValue({ error: { message: "no connection" } });
    release({ error: null });
    await pass;
    const [saved] = await store.listOutstanding();
    expect(saved?.revision).toBe("a2222222-2222-4222-8222-222222222222");
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
    const pass = drain(first, "e1500000-0000-0000-0000-000000000001");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const joined = drain(second, "e1500000-0000-0000-0000-000000000001");
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
    await drain(summary, "e1500000-0000-0000-0000-000000000001", true);
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

describe("exact capture acknowledgements", () => {
  it.each([undefined, "earlier-capture"])("retains bytes when the path receipt has revision %s", async (revision) => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => new Response(JSON.stringify({
      recorded: true, photoId: "photo", ...JSON.parse(String(init?.body)), revision,
    }), { status: 200 }));
    await store.enqueue(photo());
    await drain();
    const [saved] = await store.listOutstanding();
    expect(saved?.lastError).toBe("record: unconfirmed");
    expect(await saved?.blob.text()).toBe("original");
  });
});

describe("immutable object retries", () => {
  it("uses a capture-specific path and never requests an overwrite", async () => {
    await store.enqueue(photo());
    await drain();
    expect(upload.mock.calls[0]?.[0]).toContain("/kitchen_1-before/a1111111-1111-4111-8111-111111111111.jpg");
    expect(upload.mock.calls[0]?.[2]).toMatchObject({ upsert: false });
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(request.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.supersedes).toEqual([]);
  });
  it("continues an ambiguous already-existing upload only through exact server verification", async () => {
    upload.mockResolvedValue({ error: { statusCode: "409", message: "Already exists" } });
    await store.enqueue(photo());
    await drain();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await store.listOutstanding()).toEqual([]);
  });
  it("retains bytes if an existing object cannot produce the exact byte receipt", async () => {
    upload.mockResolvedValue({ error: { statusCode: "409", message: "Already exists" } });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ recorded: false }), { status: 409 }));
    await store.enqueue(photo());
    await drain();
    expect(await (await store.listOutstanding())[0]?.blob.text()).toBe("original");
  });
  it("durably upgrades a legacy capture before any network call without changing its bytes", async () => {
    await store.enqueue(photo({ revision: undefined }));
    upload.mockImplementation(async () => {
      const [saved] = await store.listOutstanding();
      expect(saved?.revision).toMatch(/^[0-9a-f-]{36}$/);
      expect(await saved?.blob.text()).toBe("original");
      return { error: null };
    });
    await drain();
    expect(await store.listOutstanding()).toEqual([]);
  });
});
