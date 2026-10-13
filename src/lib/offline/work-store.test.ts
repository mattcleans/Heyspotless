import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
  MAX_WORK_AGE,
  listWork,
  openPhotoDatabase,
  readWorkPhotos,
  removeWork,
  safeWork,
  saveWork,
  saveWorkPhoto,
  setWorkOwner,
  workIsFresh,
  type SavedWork,
} from "../../../public/offline-work.js";
import { enqueue, forget, listForJob, listOutstanding } from "./photo-store";

const owner = "e1100000-0000-0000-0000-000000000001";
const other = "e1100000-0000-0000-0000-000000000002";
const job = "e1500000-0000-0000-0000-000000000001";
function work(overrides: Partial<SavedWork> = {}): SavedWork {
  return {
    ownerId: owner,
    jobId: job,
    status: "in_progress",
    checkedAt: Date.now(),
    scheduledAt: new Date().toISOString(),
    rooms: [{ key: "kitchen_1", label: "Kitchen" }],
    confirmed: [],
    ...overrides,
  };
}
beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  await setWorkOwner(owner);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("minimal saved work", () => {
  it("keeps only checklist data and derives room labels without private caller text", () => {
    const saved = safeWork({
      ...work(),
      clientName: "Private",
      gateCode: "secret",
      pay: 100,
      token: "secret",
      rooms: [{ key: "kitchen_1", label: "Private home address" }],
    });
    expect(saved).toEqual({
      ...work({ scheduledAt: saved!.scheduledAt, checkedAt: saved!.checkedAt }),
      rooms: [{ key: "kitchen_1", label: "Kitchen 1" }],
    });
    expect(JSON.stringify(saved)).not.toMatch(
      /Private|secret|clientName|gateCode|pay|token/,
    );
  });
  it.each(["assigned", "canceled", "dispatching"])(
    "does not save %s as permission for offline work",
    async (status) => {
      await expect(
        saveWork({ ...work(), status } as SavedWork),
      ).rejects.toThrow();
      expect(await listWork()).toEqual([]);
    },
  );
  it.each([
    { keys: ["bad_1"] },
    { keys: ["bedroom_31"] },
    { keys: ["kitchen_1", "kitchen_1"] },
  ])("rejects invalid room keys $keys", ({ keys }) => {
    expect(
      safeWork(work({ rooms: keys.map((key) => ({ key, label: key })) })),
    ).toBeNull();
  });
  it("refuses stale or future device snapshots without removing queued bytes", async () => {
    await saveWork(work());
    const photo = await saveWorkPhoto(
      job,
      owner,
      "kitchen_1",
      "before",
      new Blob(["bytes"]),
    );
    const db = await openPhotoDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("work", "readwrite");
      tx.objectStore("work").put(
        work({ checkedAt: Date.now() - MAX_WORK_AGE }),
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    expect(workIsFresh((await listWork())[0]!)).toBe(false);
    await expect(
      saveWorkPhoto(job, owner, "kitchen_1", "after", new Blob(["after"])),
    ).rejects.toThrow("Reconnect");
    expect((await listForJob(job))[0]?.revision).toBe(photo.revision);
    await expect(
      saveWork(work({ checkedAt: Date.now() + 10 * 60 * 1000 })),
    ).rejects.toThrow();
  });
  it("does not let an old page overwrite or remove a newer observation", async () => {
    const latest = work({ checkedAt: Date.now(), status: "complete" });
    await saveWork(latest);
    expect(await saveWork(work({ checkedAt: latest.checkedAt - 1000 }))).toBe(
      false,
    );
    expect(await removeWork(job, owner, latest.checkedAt - 1000)).toBe(false);
    expect((await listWork())[0]?.status).toBe("complete");
  });
});

describe("device identity and durable captures", () => {
  it("clears checklist visibility on profile change and refuses a stale tab's save", async () => {
    await saveWork(work());
    await saveWorkPhoto(
      job,
      owner,
      "kitchen_1",
      "before",
      new Blob(["private bytes"]),
    );
    await setWorkOwner(other);
    expect(await listWork()).toEqual([]);
    expect(await saveWork(work())).toBe(false);
    expect(await readWorkPhotos(job, owner)).toEqual([]);
    expect(await listOutstanding()).toEqual([]);
    expect(await (await listForJob(job))[0]!.blob.text()).toBe("private bytes");
    await saveWork(work({ ownerId: other }));
    expect(await readWorkPhotos(job, other)).toEqual([]);
    await expect(
      saveWorkPhoto(job, other, "kitchen_1", "before", new Blob(["new"])),
    ).rejects.toThrow("earlier session");
    await expect(
      enqueue({ ...(await listForJob(job))[0]!, ownerId: other }),
    ).rejects.toThrow("another sign-in");
  });
  it("signs out checklist access without deleting unconfirmed photos", async () => {
    await saveWork(work());
    await saveWorkPhoto(job, owner, "kitchen_1", "before", new Blob(["keep"]));
    await setWorkOwner(null);
    expect(await listWork()).toEqual([]);
    await expect(
      saveWorkPhoto(job, owner, "kitchen_1", "after", new Blob(["after"])),
    ).rejects.toThrow("Sign in");
    expect(await (await listForJob(job))[0]!.blob.text()).toBe("keep");
  });
  it("commits a retake and never acknowledges it from an earlier upload", async () => {
    await saveWork(work());
    const original = await saveWorkPhoto(
      job,
      owner,
      "kitchen_1",
      "before",
      new Blob(["original"]),
    );
    const retake = await saveWorkPhoto(
      job,
      owner,
      "kitchen_1",
      "before",
      new Blob(["retake"]),
    );
    expect(retake.revision).not.toBe(original.revision);
    expect(await forget(original)).toBe(false);
    expect((await listWork())[0]?.confirmed).toEqual([]);
    expect(await (await readWorkPhotos(job, owner))[0]!.blob.text()).toBe(
      "retake",
    );
    expect(await forget(retake)).toBe(true);
    expect((await listWork())[0]?.confirmed).toEqual([
      { roomKey: "kitchen_1", kind: "before" },
    ]);
    await saveWork(work({ checkedAt: Date.now() + 1 }));
    expect((await listWork())[0]?.confirmed).toHaveLength(1);
  });
  it("rejects a write that aborts after request success instead of showing a saved tick", async () => {
    await saveWork(work());
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(
      saveWorkPhoto(job, owner, "kitchen_1", "before", new Blob(["bytes"])),
    ).rejects.toThrow("aborted");
    expect(await listForJob(job)).toEqual([]);
  });
  it("upgrades the original photo database without losing a pending capture", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("spotless-photos", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("queue", {
          keyPath: "id",
        });
        store.createIndex("byJob", "jobId");
        store.createIndex("byState", "state");
        store.put({
          id: `${job}:kitchen_1:before`,
          jobId: job,
          roomKey: "kitchen_1",
          kind: "before",
          state: "pending",
          attempts: 0,
          takenAt: 1,
          nextAttemptAt: 1,
          blob: new Blob(["legacy bytes"]),
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await setWorkOwner(owner);
    await saveWork(work());
    expect(await (await listForJob(job))[0]!.blob.text()).toBe("legacy bytes");
    expect(await readWorkPhotos(job, owner)).toEqual([]);
    expect(await listOutstanding()).toHaveLength(1);
  });
});
