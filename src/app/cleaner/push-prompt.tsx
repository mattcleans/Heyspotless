"use client";

import { useEffect, useState } from "react";

/**
 * "Notify me about offers."
 *
 * WHY THIS IS A BUTTON AND NOT SOMETHING THE PAGE DOES ON LOAD. Every browser
 * requires a user gesture, and a permission prompt that appears unprompted is
 * the one people deny — and a denial is close to permanent, because there is no
 * way to ask again from the page.
 *
 * WHY IT SAYS WHAT IT IS FOR FIRST. She is being asked to let a business
 * interrupt her. The trade — offers arrive in seconds rather than in a text
 * thread — is worth stating before the browser's own dialogue appears, because
 * the browser's dialogue says nothing useful.
 *
 * ON iOS THIS ONLY WORKS ONCE THE APP IS ON THE HOME SCREEN. Safari does not
 * offer push to a tab, so on an iPhone that has not installed it the button
 * explains that rather than failing silently.
 */

type State =
  | { status: "checking" }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable" }
  | { status: "ready" }
  | { status: "working" }
  | { status: "on" }
  | { status: "denied" }
  | { status: "failed"; message: string };

export function PushPrompt() {
  const [state, setState] = useState<State>({ status: "checking" });

  useEffect(() => {
    void (async () => {
      if (typeof window === "undefined") return;

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        // iOS Safari in a tab: the APIs are absent until the app is installed.
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        setState({
          status: "unsupported",
          reason: isIos
            ? "On iPhone, add Spotless to your home screen first — tap Share, then Add to Home Screen. Notifications work from there."
            : "This browser cannot show notifications.",
        });
        return;
      }

      // Is push configured on the server at all? If not, say nothing rather
      // than offering a button that cannot work.
      const response = await fetch("/api/push/subscribe").catch(() => null);
      const config = (await response?.json().catch(() => null)) as
        | { enabled?: boolean; publicKey?: string }
        | null;

      if (!config?.enabled || !config.publicKey) {
        setState({ status: "unavailable" });
        return;
      }

      if (Notification.permission === "denied") {
        setState({ status: "denied" });
        return;
      }

      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      setState({ status: existing ? "on" : "ready" });
    })();
  }, []);

  async function enable() {
    setState({ status: "working" });

    try {
      const response = await fetch("/api/push/subscribe");
      const config = (await response.json()) as { publicKey?: string };
      if (!config.publicKey) {
        setState({ status: "unavailable" });
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState({ status: "denied" });
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        // Required by every browser: a push must result in something visible.
        // We show one every time, so this costs nothing.
        userVisibleOnly: true,
        applicationServerKey: toUint8Array(config.publicKey),
      });

      const saved = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });

      if (!saved.ok) {
        setState({ status: "failed", message: "Could not save that. Try again." });
        return;
      }

      setState({ status: "on" });
    } catch (error) {
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : "Could not turn those on.",
      });
    }
  }

  if (state.status === "checking" || state.status === "unavailable") return null;

  if (state.status === "on") {
    return (
      <p className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
        Notifications are on for this device. Offers will ring here as well as arriving by text.
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface-2 p-3">
      <p className="text-sm font-medium text-navy">Get offers the moment they appear</p>
      <p className="mt-1 text-xs text-ink-2">
        Offers close quickly — often inside fifteen minutes. A notification reaches you in
        seconds; a text can sit in a thread. You will still get the text either way.
      </p>

      {state.status === "unsupported" ? (
        <p className="mt-2 text-xs text-ink-3">{state.reason}</p>
      ) : state.status === "denied" ? (
        <p className="mt-2 text-xs text-ink-3">
          Notifications are blocked for this site. Turn them back on in your browser&apos;s
          settings for this page, then come back.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={state.status === "working"}
            onClick={() => void enable()}
            className="mt-2 rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {state.status === "working" ? "Turning on…" : "Turn on notifications"}
          </button>
          {state.status === "failed" ? (
            <p className="mt-2 text-xs text-bad">{state.message}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The public key, as `applicationServerKey` wants it: raw bytes, not base64url.
 *
 * Passing the string straight through is the mistake that produces a
 * subscription the push service will never accept, and nothing says so until
 * nobody gets a notification.
 */
function toUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);

  // Explicitly backed by an ArrayBuffer rather than the SharedArrayBuffer the
  // default type allows: `applicationServerKey` will not take the latter.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
