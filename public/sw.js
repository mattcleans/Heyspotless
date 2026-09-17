/**
 * The service worker.
 *
 * Its whole job is the push notification. There is no offline caching here on
 * purpose: the offline story in this app is the photo queue, which lives in the
 * page and writes to IndexedDB before anything touches the network, and a cache
 * that serves a stale dispatch board to a cleaner standing on a doorstep would
 * be worse than no cache at all.
 *
 * THE PUSH CARRIES NO DATA. It is a tickle — see src/lib/push/vapid.ts. When it
 * arrives this asks our own API what is waiting, so the notification says what
 * is true NOW rather than what was true when the push was queued. A rung lives
 * 8 to 15 minutes; a notification about a job somebody else has already taken
 * is worse than none.
 */

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close. A cleaner
  // who just enabled notifications should get the next offer, not the one after
  // she next quits the app.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

  const url = (event.notification.data && event.notification.data.url) || "/cleaner";

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
