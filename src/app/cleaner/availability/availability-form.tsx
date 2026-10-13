"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseAvailability, type AvailabilityWindow } from "@/lib/cleaners/availability-input";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fieldClass = "mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base";

export function AvailabilityForm({ initialWindows, demo }: { initialWindows: AvailabilityWindow[]; demo: boolean }) {
  const router = useRouter();
  const nextKey = useRef(initialWindows.length);
  const [windows, setWindows] = useState(() => initialWindows.map((w, key) => ({ ...w, key })));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  function edit(key: number, patch: Partial<AvailabilityWindow>) {
    setWindows(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
    setMessage(null);
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo || saving) return;
    setFailed(false); setExpired(false); setMessage(null);
    let clean;
    try { clean = parseAvailability(windows); }
    catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Check your hours."); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/cleaner/availability", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ windows: clean }) });
      const data = await response.json().catch(() => ({})) as { saved?: boolean; error?: string };
      if (!response.ok || data.saved !== true) {
        setFailed(true); setExpired(response.status === 401);
        setMessage(typeof data.error === "string" ? data.error : "We could not confirm the save. Your edits are still here. Try again or call the office.");
        return;
      }
      setMessage("Working hours saved. Your accepted visits keep their existing times.");
      router.refresh();
    } catch { setFailed(true); setMessage("We could not confirm the save. Your edits are still here. Check your connection and try again."); }
    finally { setSaving(false); }
  }
  return <form onSubmit={event => void save(event)} className="mt-6 space-y-4">
    {initialWindows.length === 0 && <p className="text-sm text-ink-2">No weekly hours have been declared yet. The office may still consider you for visits until you save a schedule.</p>}
    {demo && <p className="text-sm text-ink-2">These are sample hours. You can try editing them; saving requires your signed-in cleaner account.</p>}
    <fieldset disabled={saving} className="space-y-4">
      <legend className="sr-only">Weekly working windows in Dallas time</legend>
      {windows.map((w, index) => <fieldset key={w.key} className="visit-feature">
        <legend className="px-2 text-sm font-semibold text-navy">Working window {index + 1}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-ink-2">Day<span className="sr-only"> for window {index + 1}</span><select value={w.day} onChange={e => edit(w.key, { day: Number(e.target.value) })} className={fieldClass}>{DAYS.map((day, value) => <option key={day} value={value}>{day}</option>)}</select></label>
          <label className="text-sm text-ink-2">Start<span className="sr-only"> for window {index + 1}</span><input type="time" step={60} required value={w.startsAt} onInput={e => edit(w.key, { startsAt: e.currentTarget.value })} onChange={e => edit(w.key, { startsAt: e.target.value })} className={fieldClass} /></label>
          <label className="text-sm text-ink-2">End<span className="sr-only"> for window {index + 1}</span><input type="time" step={60} required value={w.endsAt} onInput={e => edit(w.key, { endsAt: e.currentTarget.value })} onChange={e => edit(w.key, { endsAt: e.target.value })} className={fieldClass} /></label>
        </div>
        <button type="button" onClick={() => { setWindows(rows => rows.filter(row => row.key !== w.key)); setMessage(null); }} aria-label={`Remove window ${index + 1}`} className="secondary-action mt-3">Remove window</button>
      </fieldset>)}
      <button type="button" disabled={windows.length >= 28} onClick={() => { setWindows(rows => [...rows, { key: nextKey.current++, day: 1, startsAt: "09:00", endsAt: "17:00" }]); setMessage(null); }} className="secondary-action">Add working window</button>
      <button type="submit" disabled={demo} className="primary-action ml-3 disabled:opacity-50">{saving ? "Saving hours…" : "Save working hours"}</button>
    </fieldset>
    {message && <p role={failed ? "alert" : "status"} className={`rounded-lg border border-line p-3 text-sm ${failed ? "text-bad" : "text-ink-2"}`}>{message}{expired && <Link href="/login?next=%2Fcleaner%2Favailability" className="ml-2 underline">Sign in again</Link>}</p>}
  </form>;
}
