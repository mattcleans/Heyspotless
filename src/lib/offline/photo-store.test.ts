import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { enqueue, forget, isAvailable, listForJob, listOutstanding, update, type StoredPhoto } from "./photo-store";
import { openPhotoDatabase } from "../../../public/offline-work.js";

function photo(overrides: Partial<StoredPhoto> = {}): StoredPhoto {
  return { id: "job:kitchen:before", jobId: "job", roomKey: "kitchen", kind: "before",
    takenAt: 1000, revision: "original", state: "pending", attempts: 0, nextAttemptAt: 0,
    blob: new Blob(["original bytes"], { type: "image/jpeg" }), ...overrides };
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("photo storage capability", () => {
  it("does not mistake an open database for support for image bytes", async () => {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      if (value.blob instanceof Blob)
        throw new DOMException("Blob writes unavailable", "DataCloneError");
      return put.call(this, value, key);
    });
    const db = await openPhotoDatabase();
    db.close();
    expect(await isAvailable()).toBe(false);
  });

  it("waits for commit and reports a transaction abort as unavailable", async () => {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    expect(await isAvailable()).toBe(false);
  });

  it("leaves the signed-in owner and queued photos intact without retaining a probe", async () => {
    await enqueue(photo({ ownerId: "cleaner" }));
    const db = await openPhotoDatabase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("device", "readwrite");
      tx.objectStore("device").put({ key: "owner", ownerId: "cleaner" });
      tx.oncomplete = () => resolve();
    });
    expect(await isAvailable()).toBe(true);
    const deviceRecords = await new Promise<unknown[]>((resolve) => {
      const tx = db.transaction("device", "readonly");
      const request = tx.objectStore("device").getAll();
      tx.oncomplete = () => resolve(request.result);
    });
    db.close();
    expect(deviceRecords).toEqual([{ key: "owner", ownerId: "cleaner" }]);
    expect(await listForJob("job", "cleaner")).toHaveLength(1);
  });
});

describe("durable photo writes", () => {
  it("rejects an abort after the put request succeeds and leaves no saved photo", async () => {
    const put = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener("success", () => {
        requestSucceeded = true;
        this.transaction.abort();
      });
      return request;
    });
    await expect(enqueue(photo())).rejects.toThrow("aborted");
    expect(requestSucceeded).toBe(true);
    spy.mockRestore();
    expect(await listForJob("job")).toEqual([]);
  });

  it("resolves only with a committed, readable copy of the bytes", async () => {
    await enqueue(photo());
    const stored = (await listForJob("job"))[0]!;
    expect(await stored.blob.text()).toBe("original bytes");
    expect(stored.revision).toBe("original");
  });
});

describe("retaking a room photo", () => {
  it("does not let an earlier success delete a retake captured in the same millisecond", async () => {
    const original = photo();
    await enqueue(original);
    await enqueue(photo({ revision: "retake", blob: new Blob(["new bytes"]) }));
    expect(await forget(original)).toBe(false);
    const stored = (await listForJob("job"))[0]!;
    expect(await stored.blob.text()).toBe("new bytes");
    expect(stored.state).toBe("pending");
  });

  it("does not let an earlier failed upload overwrite the retake's pending state", async () => {
    const original = photo();
    await enqueue(original);
    await enqueue(photo({ revision: "retake" }));
    expect(await update({ ...original, attempts: 8, nextAttemptAt: 99999, lastError: "old failure" })).toBe(false);
    const [stored] = await listForJob("job");
    expect(stored?.attempts).toBe(0);
    expect(stored?.lastError).toBeUndefined();
  });

  it("keeps a new capture when an older transaction settles at the same time", async () => {
    const original = photo();
    await enqueue(original);
    await Promise.all([forget(original), enqueue(photo({ revision: "retake" }))]);
    expect((await listForJob("job"))[0]?.revision).toBe("retake");
  });

  it("updates and removes matching legacy records without a revision", async () => {
    const legacy = photo({ revision: undefined });
    await enqueue(legacy);
    expect(await update({ ...legacy, state: "uploading" })).toBe(true);
    expect((await listOutstanding())[0]?.state).toBe("uploading");
    expect(await forget(legacy)).toBe(true);
    expect(await listOutstanding()).toEqual([]);
  });

  it("cannot change an absent photo or another job", async () => {
    await enqueue(photo());
    expect(await update(photo({ jobId: "other" }))).toBe(false);
    expect(await forget(photo({ id: "absent" }))).toBe(false);
    expect(await listOutstanding()).toHaveLength(1);
  });
});

describe("durable retake replacement identity", () => {
  const first = "a1111111-1111-4111-8111-111111111111";
  const second = "a2222222-2222-4222-8222-222222222222";
  const third = "a3333333-3333-4333-8333-333333333333";

  it("retains every replaced capture across reloads without using capture timestamps", async () => {
    await enqueue(photo({ revision: first }));
    await enqueue(photo({ revision: second, takenAt: 1, blob: new Blob(["second"]) }));
    const [reopened] = await listForJob("job");
    expect(reopened?.supersedes).toEqual([first]);
    await enqueue(photo({ revision: third, takenAt: 1, blob: new Blob(["third"]) }));
    expect(await forget(photo({ revision: first }))).toBe(false);
    expect(await update(photo({ revision: second, state: "done" }))).toBe(false);
    const [latest] = await listForJob("job");
    expect(latest?.supersedes).toEqual([first, second]);
    expect(await latest?.blob.text()).toBe("third");
  });

  it("refuses to reuse a capture identity for different bytes", async () => {
    await enqueue(photo({ revision: first }));
    await expect(enqueue(photo({ revision: first, blob: new Blob(["different bytes"]) }))).rejects.toThrow("same revision");
    expect(await (await listForJob("job"))[0]?.blob.text()).toBe("original bytes");
  });
});

describe("unresolved retake history limit", () => {
  it("refuses another retake without truncating replacement history or discarding saved bytes", async () => {
    for (let capture = 0; capture < 65; capture++) {
      await enqueue(photo({ revision: crypto.randomUUID(), blob: new Blob([`capture ${capture}`]) }));
    }
    const [before] = await listForJob("job");
    expect(before?.supersedes).toHaveLength(64);
    await expect(enqueue(photo({ revision: crypto.randomUUID(), blob: new Blob(["one too many"]) }))).rejects.toThrow("Reconnect");
    const [after] = await listForJob("job");
    expect(after?.revision).toBe(before?.revision);
    expect(after?.supersedes).toEqual(before?.supersedes);
    expect(await after?.blob.text()).toBe("capture 64");
  });
});
