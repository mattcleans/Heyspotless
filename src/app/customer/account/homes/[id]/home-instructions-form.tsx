"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { INSTRUCTION_FIELDS, INSTRUCTION_LABELS, INSTRUCTION_LIMITS, parseHomeInstructions, type HomeInstructions, type InstructionField } from "@/lib/customer/home-instructions";

const fieldClass = "mt-1 block min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-base";
export function HomeInstructionsForm({ homeId, initialInstructions, demo }: { homeId: string; initialInstructions: HomeInstructions; demo: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialInstructions), [expected, setExpected] = useState(initialInstructions);
  const [saving, setSaving] = useState(false), [showGate, setShowGate] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failed, setFailed] = useState(false), [expired, setExpired] = useState(false);
  const [latest, setLatest] = useState<HomeInstructions | null>(null);
  function edit(field: InstructionField, value: string) {
    setDraft(old => ({ ...old, [field]: value })); setMessage(null);
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo || saving || latest) return;
    setMessage(null); setFailed(false); setExpired(false);
    let instructions;
    try { instructions = parseHomeInstructions(draft); }
    catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Check your home instructions."); return; }
    setSaving(true);
    try {
      const response = await fetch(`/api/customer/homes/${encodeURIComponent(homeId)}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instructions, expected }) });
      const data = await response.json().catch(() => ({})) as { saved?: boolean; instructions?: unknown; latest?: unknown; error?: string };
      if (!response.ok || data.saved !== true) {
        if (response.status === 409 && data.latest) setLatest(parseHomeInstructions(data.latest, false));
        setFailed(true); setExpired(response.status === 401);
        setMessage(typeof data.error === "string" ? data.error : "We could not confirm the save. Your edits are still here. Try again or call the office.");
        return;
      }
      const saved = parseHomeInstructions(data.instructions);
      setDraft(saved); setExpected(saved); setLatest(null);
      setMessage("Home instructions saved. Your assigned cleaner can see them when they open your visit.");
      router.refresh();
    } catch { setFailed(true); setMessage("We could not confirm the save. Your edits are still here. Check your connection and try again."); }
    finally { setSaving(false); }
  }
  function applyLatest(keepEdits: boolean) {
    if (!latest) return;
    setExpected(latest); if (!keepEdits) setDraft(latest);
    setLatest(null); setFailed(false);
    setMessage(keepEdits ? "Your edits are kept. Save to replace the latest instructions you just reviewed." : "Latest instructions loaded. Review them before saving any changes.");
  }
  return <form onSubmit={event => void save(event)} className="mt-6 space-y-4">
    {demo && <p className="rounded-lg bg-sky-50 p-3 text-sm text-ink-2">These are sample home instructions. You can try editing them; saving requires your signed-in client account.</p>}
    <fieldset disabled={saving} className="space-y-4">
      <legend className="sr-only">Instructions for your assigned cleaner</legend>
      {INSTRUCTION_FIELDS.map(field => <div key={field}>
        <label htmlFor={`${homeId}-${field}`} className="text-sm font-semibold text-navy">{INSTRUCTION_LABELS[field]}</label>
        {field === "gateCode" ? <><input id={`${homeId}-${field}`} type={showGate ? "text" : "password"} autoComplete="off" value={draft[field] ?? ""} maxLength={INSTRUCTION_LIMITS[field]} onChange={e => edit(field, e.target.value)} className={fieldClass} />
          <button type="button" onClick={() => setShowGate(!showGate)} aria-controls={`${homeId}-${field}`} className="secondary-action mt-2">{showGate ? "Hide gate code" : "Show gate code"}</button></>
          : <textarea id={`${homeId}-${field}`} rows={3} value={draft[field] ?? ""} maxLength={INSTRUCTION_LIMITS[field]} onChange={e => edit(field, e.target.value)} className={fieldClass} />}
        <p className="mt-1 text-xs text-ink-2">{INSTRUCTION_LIMITS[field]} characters maximum. Leave blank to remove this instruction.</p>
      </div>)}
      <button type="submit" disabled={demo || Boolean(latest)} className="primary-action disabled:opacity-50">{saving ? "Saving instructions…" : "Save home instructions"}</button>
    </fieldset>
    {message && <p role={failed ? "alert" : "status"} className={`rounded-lg border border-line p-3 text-sm ${failed ? "text-bad" : "text-ink-2"}`}>{message}{expired && <Link href="/login?next=%2Fcustomer%2Faccount%2Fhomes" className="ml-2 underline">Sign in again</Link>}</p>}
    {latest && <section aria-labelledby="latest-instructions" className="visit-feature">
      <h2 id="latest-instructions" className="font-semibold text-navy">Latest saved instructions</h2>
      <p className="mt-2 text-sm text-ink-2">Your edits are still in the form above. Compare them with these saved details, then choose which to keep.</p>
      <dl className="mt-3 space-y-3 text-sm">{INSTRUCTION_FIELDS.map(field => <div key={field}>
        <dt className="font-semibold text-navy">{INSTRUCTION_LABELS[field]}</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words text-ink-2">{field === "gateCode" && latest[field] ? showGate ? latest[field] : "Code saved. Use Show gate code above to reveal it." : latest[field] || "No instruction saved"}</dd>
      </div>)}</dl>
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={saving} onClick={() => applyLatest(false)} className="secondary-action">Use latest instructions</button><button type="button" disabled={saving} onClick={() => applyLatest(true)} className="secondary-action">Keep my edits</button></div>
    </section>}
  </form>;
}
