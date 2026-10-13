/**
 * The service worker.
 *
 * Push plus a static device-recovery screen. Live pages, API responses and
 * dispatch boards are NEVER cached. Only failed cleaner navigations fall back
 * to the minimal local checklist, labeled as earlier work.
 *
 * THE PUSH CARRIES NO DATA. It is a tickle — see src/lib/push/vapid.ts. When it
 * arrives this asks our own API what is waiting, so the notification says what
 * is true NOW rather than what was true when the push was queued. A rung lives
 * 8 to 15 minutes; a notification about a job somebody else has already taken
 * is worse than none.
 */

// Bump this when recovery assets change so an updated install replaces them.
const WORK_CACHE = "spotless-work-shell-20261003-2";
const WORK_ASSETS = [
  "/offline-cleaner.html",
  "/offline-cleaner.js",
  "/offline-work.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(WORK_CACHE).then((cache) => cache.addAll(WORK_ASSETS)),
  );
  // Take over immediately rather than waiting for every tab to close. A cleaner
  // who just enabled notifications should get the next offer, not the one after
  // she next quits the app.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("spotless-work-shell-") && key !== WORK_CACHE)
          await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "offline-work-ready")
    event.ports[0]?.postMessage("offline-work-ready");
});

async function clearSavedWork() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("spotless-photos");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (
        !db.objectStoreNames.contains("work") ||
        !db.objectStoreNames.contains("device")
      ) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(["work", "device"], "readwrite");
      tx.objectStore("work").clear();
      tx.objectStore("device").put({ key: "owner", ownerId: null });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("spotless-work");
    channel.postMessage("signed-out");
    channel.close();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && url.pathname === "/auth/sign-out") {
    event.respondWith(
      (async () => {
        try {
          await clearSavedWork();
        } catch {
          return new Response(
            "Could not clear saved checklist access. Close other Spotless tabs and try signing out again.",
            { status: 503 },
          );
        }
        return fetch(request);
      })(),
    );
    return;
  }
  if (request.method !== "GET") return;
  if (WORK_ASSETS.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          return (await caches.open(WORK_CACHE))
            .match(url.pathname)
            .then((response) => response ?? Response.error());
        }
      })(),
    );
    return;
  }
  // The installed PWA starts at /; it needs the same recovery after a restart.
  if (
    request.mode === "navigate" &&
    (url.pathname === "/" || /^\/cleaner(?:\/|$)/.test(url.pathname))
  ) {
    event.respondWith(
      (async () => {
        let response;
        try {
          response = await fetch(request);
        } catch {
          return (await caches.open(WORK_CACHE))
            .match("/offline-cleaner.html")
            .then((response) => response ?? Response.error());
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          new URL(response.url || request.url).pathname === "/login"
        )
          await clearSavedWork().catch(() => {});
        return response;
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(showWhatIsWaiting());
});

async function showWhatIsWaiting() {
  let offer = null;

  try {
    const response = await fetch("/api/cleaner/pending", {
      // The session cookie is what identifies her. Without this the request is
      // anonymous and the answer is always "nothing".
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (response.ok) offer = await response.json();
  } catch {
    // Offline, or the session expired. Fall through to the generic notification
    // below: a push that shows nothing at all is a push that trains her to
    // ignore the app.
  }

  if (offer && offer.expired) {
    // Somebody else took it while the push was in flight. Say nothing —
    // a notification about a job that is gone is worse than silence.
    return;
  }

  const title = offer && offer.title ? offer.title : "A clean is available";
  const body =
    offer && offer.body ? offer.body : "Open Spotless to see what is waiting.";

  return self.registration.showNotification(title, {
    body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    // So a second push about the same job replaces the first rather than
    // stacking. The ladder re-presents an offer every sweep.
    tag: offer && offer.jobId ? `offer-${offer.jobId}` : "offer",
    renotify: true,
    // She is often holding the phone in one hand with gloves on. Vibration is
    // the part of this she will actually notice.
    vibrate: [120, 60, 120],
    requireInteraction: false,
    data: { url: offer && offer.url ? offer.url : "/cleaner" },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url =
    (event.notification.data && event.notification.data.url) || "/cleaner";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Reuse a tab that is already open rather than piling up windows — she
      // has one phone and may answer twenty of these a week.
      for (const client of windows) {
        if (client.url.includes("/cleaner") && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }

      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

/**
 * A push service may rotate a subscription at any time. When it does, the old
 * endpoint stops working and nothing says so — she simply stops being notified.
 * Re-registering here is what keeps that from being permanent.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const subscription = await self.registration.pushManager.subscribe(
        event.oldSubscription
          ? event.oldSubscription.options
          : { userVisibleOnly: true },
      );

      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    })(),
  );
});
