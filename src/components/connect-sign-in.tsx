"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { formatDateTimeInZone } from "@/lib/time/zone";
import type { SignInStatus } from "@/lib/customers/sign-in-connection";

/**
 * Connect a customer's confirmed sign-in to this record. A person confirms
 * who the customer is; the database checks everything else.
 */
export function ConnectSignIn({
  customerId,
  customerName,
  status,
}: {
  customerId: string;
  customerName: string;
  status: SignInStatus;
}) {
  const router = useRouter();
  const locked = useRef(false);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function connect(profileId: string) {
    if (locked.current || confirmed[profileId] !== true) return;
    locked.current = true;
    setWorking(profileId);
    try {
      const response = await fetchWithTimeout(`/api/admin/customers/${customerId}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId, confirmedIdentity: true }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message = typeof body["message"] === "string" ? body["message"] : "The connection could not be confirmed. Refresh the page before trying again.";
      setResult({ ok: response.ok && body["connected"] === true, message });
      if (response.ok) router.refresh();
    } catch {
      setResult({ ok: false, message: "The connection could not be confirmed. Refresh the page before trying again." });
    } finally {
      locked.current = false;
      setWorking(null);
    }
  }

  if (status.connected) {
    return (
      <div className="card p-5 text-sm">
        <p className="font-semibold text-ink">Connected to a sign-in</p>
        <p className="mt-1 text-ink-2">
          {status.connected.email ?? "Sign-in email unavailable"}
          {status.connected.connectedAt
            ? ` · connected ${formatDateTimeInZone(new Date(status.connected.connectedAt))}`
            : ""}
        </p>
        <p className="mt-2 text-ink-3">
          {customerName} sees this record, their homes and their visits when they sign in.
        </p>
      </div>
    );
  }

  return (
    <div className="card space-y-4 p-5 text-sm">
      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`font-semibold ${result.ok ? "text-good" : "text-bad"}`}>
          {result.message}
        </p>
      ) : null}

      {status.candidates.length === 0 ? (
        <div className="space-y-2 text-ink-2">
          <p className="font-semibold text-ink">No sign-in to connect yet</p>
          {status.customerEmail ? (
            <p>
              When {customerName} signs up with <span className="nums">{status.customerEmail}</span> and confirms
              that email, their sign-in appears here.
            </p>
          ) : (
            <p>This customer has no email on file. Add the email they’ll sign up with, then their sign-in can appear here.</p>
          )}
          <p className="text-ink-3">
            If they signed up with a different email, update their contact details below to that email first.
          </p>
        </div>
      ) : (
        <>
          <p className="text-ink-2">
            These sign-ups confirmed this customer’s email. Before connecting, confirm it’s really {customerName}, for
            example by calling the number on file. Anyone can sign up with any email; confirming it is what makes the
            connection safe.
          </p>
          {status.customersWithThisEmail > 1 ? (
            <p role="note" className="rounded-lg bg-cream-soft p-3 text-ink">
              This email is on {status.customersWithThisEmail} customer records. Check this is the right one before
              connecting, because a sign-in can only belong to one customer.
            </p>
          ) : null}
          <ul className="space-y-3">
            {status.candidates.map((c) => (
              <li key={c.profileId} className="rounded-xl border border-line p-4">
                <p className="font-semibold text-ink">{c.email}</p>
                <p className="mt-0.5 text-ink-3">
                  {c.signedUpAt ? `Signed up ${formatDateTimeInZone(new Date(c.signedUpAt))}` : "Sign-up date unknown"}
                  {c.confirmedAt ? ` · email confirmed ${formatDateTimeInZone(new Date(c.confirmedAt))}` : ""}
                </p>
                <label className="mt-3 flex min-h-11 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={confirmed[c.profileId] === true}
                    disabled={working !== null}
                    onChange={(e) => setConfirmed((m) => ({ ...m, [c.profileId]: e.target.checked }))}
                  />
                  <span>I’ve confirmed this sign-in is {customerName}.</span>
                </label>
                <button
                  type="button"
                  className="mt-2 min-h-11 rounded-full bg-navy px-5 py-2.5 font-semibold text-white disabled:opacity-50"
                  disabled={confirmed[c.profileId] !== true || working !== null}
                  onClick={() => void connect(c.profileId)}
                >
                  {working === c.profileId ? "Connecting…" : "Connect this sign-in"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
