// Shared by the authenticated app, static recovery page and service worker.
// This is device recovery, never proof that an assignment is still current.
export const MAX_WORK_AGE = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_NAMES = {
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  half_bath: "Half bath",
  living_room: "Living room",
  bedroom: "Bedroom",
  utility_room: "Utility room",
};

export function openPhotoDatabase() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("spotless-photos", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("queue")) {
        const queue = db.createObjectStore("queue", { keyPath: "id" });
        queue.createIndex("byJob", "jobId");
        queue.createIndex("byState", "state");
      }
      if (!db.objectStoreNames.contains("work"))
        db.createObjectStore("work", { keyPath: "jobId" });
      if (!db.objectStoreNames.contains("device"))
        db.createObjectStore("device", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Device storage unavailable"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other Spotless tabs to update device storage"));
    };
  });
}

async function transaction(stores, mode, work) {
  const db = await openPhotoDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      let failure;
      const done = (value) => {
        result = value;
      };
      const fail = (error) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new Error("Device storage transaction aborted"),
        );
      try {
        work(tx, done, fail);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function setWorkOwner(ownerId) {
  const owner =
    typeof ownerId === "string" && UUID.test(ownerId) ? ownerId : null;
  await transaction(["device", "work"], "readwrite", (tx, done) => {
    const device = tx.objectStore("device");
    const request = device.get("owner");
    request.onsuccess = () => {
      if (request.result?.ownerId !== owner) tx.objectStore("work").clear();
      device.put({ key: "owner", ownerId: owner });
      done(true);
    };
  });
}

export function safeWork(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !UUID.test(value.jobId ?? "") ||
    !UUID.test(value.ownerId ?? "") ||
    !["in_progress", "complete"].includes(value.status) ||
    !Number.isFinite(value.checkedAt) ||
    !Array.isArray(value.rooms) ||
    value.rooms.length > 180
  )
    return null;
  const keys = new Set();
  const rooms = [];
  for (const room of value.rooms) {
    const match =
      typeof room?.key === "string" &&
      /^(kitchen|bathroom|half_bath|living_room|bedroom|utility_room)_([1-9]|[12][0-9]|30)$/.exec(
        room.key,
      );
    if (!match || keys.has(room.key)) return null;
    keys.add(room.key);
    rooms.push({ key: room.key, label: `${ROOM_NAMES[match[1]]} ${match[2]}` });
  }
  if (Array.isArray(value.confirmed) && value.confirmed.length > 360)
    return null;
  const confirmed = Array.isArray(value.confirmed)
    ? value.confirmed
        .filter(
          (p) =>
            p && keys.has(p.roomKey) && ["before", "after"].includes(p.kind),
        )
        .map((p) => ({ roomKey: p.roomKey, kind: p.kind }))
    : [];
  const scheduledAt =
    typeof value.scheduledAt === "string" &&
    Number.isFinite(Date.parse(value.scheduledAt))
      ? new Date(value.scheduledAt).toISOString()
      : null;
  // Explicit projection prevents client notes, pay, home access or tokens entering the cache.
  return {
    jobId: value.jobId,
    ownerId: value.ownerId,
    status: value.status,
    checkedAt: value.checkedAt,
    scheduledAt,
    rooms,
    confirmed,
  };
}

export function workIsFresh(work, now = Date.now()) {
  return (
    Number.isFinite(work?.checkedAt) &&
    now >= work.checkedAt - 5 * 60 * 1000 &&
    now - work.checkedAt < MAX_WORK_AGE
  );
}

export async function saveWork(value) {
  const work = safeWork(value);
  if (!work || !workIsFresh(work))
    throw new Error("Saved checklist unavailable; reopen your visit online");
  return transaction(["device", "work"], "readwrite", (tx, done) => {
    const request = tx.objectStore("device").get("owner");
    request.onsuccess = () => {
      if (request.result?.ownerId !== work.ownerId) return done(false);
      const store = tx.objectStore("work");
      const previous = store.get(work.jobId);
      previous.onsuccess = () => {
        const saved = safeWork(previous.result);
        if (saved?.checkedAt > work.checkedAt) return done(false);
        const confirmed = [...(saved?.confirmed ?? []), ...work.confirmed];
        const unique = new Map(
          confirmed
            .filter((p) => work.rooms.some((r) => r.key === p.roomKey))
            .map((p) => [`${p.roomKey}:${p.kind}`, p]),
        );
        store.put({ ...work, confirmed: [...unique.values()] });
        done(true);
      };
    };
  });
}

export async function removeWork(jobId, ownerId, checkedAt = Infinity) {
  return transaction(["device", "work"], "readwrite", (tx, done) => {
    const request = tx.objectStore("device").get("owner");
    request.onsuccess = () => {
      if (request.result?.ownerId !== ownerId) return done(false);
      const store = tx.objectStore("work");
      const previous = store.get(jobId);
      previous.onsuccess = () => {
        if (previous.result?.checkedAt > checkedAt) return done(false);
        store.delete(jobId);
        done(true);
      };
    };
  });
}

export async function listWork() {
  return transaction(["device", "work"], "readonly", (tx, done) => {
    const owner = tx.objectStore("device").get("owner");
    owner.onsuccess = () => {
      const request = tx.objectStore("work").getAll();
      request.onsuccess = () =>
        done(
          request.result
            .map(safeWork)
            .filter((w) => w && owner.result?.ownerId === w.ownerId)
            .sort((a, b) => b.checkedAt - a.checkedAt),
        );
    };
  });
}

export async function readWorkPhotos(jobId, ownerId) {
  return transaction(["device", "queue"], "readonly", (tx, done) => {
    const owner = tx.objectStore("device").get("owner");
    owner.onsuccess = () => {
      if (owner.result?.ownerId !== ownerId) return done([]);
      const request = tx.objectStore("queue").index("byJob").getAll(jobId);
      request.onsuccess = () =>
        done(request.result.filter((p) => p.ownerId === ownerId));
    };
  });
}

export async function saveWorkPhoto(jobId, ownerId, roomKey, kind, blob) {
  if (
    !(blob instanceof Blob) ||
    blob.size === 0 ||
    !["before", "after"].includes(kind)
  )
    throw new Error("Choose a photo to save");
  return transaction(
    ["device", "work", "queue"],
    "readwrite",
    (tx, done, fail) => {
      const owner = tx.objectStore("device").get("owner");
      owner.onsuccess = () => {
        if (owner.result?.ownerId !== ownerId)
          return fail(new Error("Sign in again before saving more photos"));
        const request = tx.objectStore("work").get(jobId);
        request.onsuccess = () => {
          const work = safeWork(request.result);
          if (
            !work ||
            work.ownerId !== ownerId ||
            work.status !== "in_progress" ||
            !workIsFresh(work) ||
            !work.rooms.some((r) => r.key === roomKey)
          )
            return fail(
              new Error(
                "Reconnect and reopen your visit before saving more photos",
              ),
            );
          const now = Date.now();
          const photo = {
            id: `${jobId}:${roomKey}:${kind}`,
            jobId,
            ownerId,
            roomKey,
            kind,
            blob,
            takenAt: now,
            revision: crypto.randomUUID(),
            state: "pending",
            attempts: 0,
            nextAttemptAt: now,
          };
          const queue = tx.objectStore("queue");
          const previous = queue.get(photo.id);
          previous.onsuccess = () => {
            if (previous.result && previous.result.ownerId !== ownerId)
              return fail(
                new Error(
                  "A photo from an earlier session is still saved. Reconnect or call the office before replacing it",
                ),
              );
            queue.put(photo);
            done(photo);
          };
        };
      };
    },
  );
}

// Called only in the same transaction that removes a server-confirmed capture.
export function markWorkPhotoConfirmed(tx, photo) {
  const request = tx.objectStore("work").get(photo.jobId);
  request.onsuccess = () => {
    const work = safeWork(request.result);
    if (
      !work ||
      !work.rooms.some((r) => r.key === photo.roomKey) ||
      !["before", "after"].includes(photo.kind)
    )
      return;
    if (
      !work.confirmed.some(
        (p) => p.roomKey === photo.roomKey && p.kind === photo.kind,
      )
    ) {
      tx.objectStore("work").put({
        ...work,
        confirmed: [
          ...work.confirmed,
          { roomKey: photo.roomKey, kind: photo.kind },
        ],
      });
    }
  };
}
