"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { parseHomeSetup, savedHome, ROOM_FIELDS, ROOM_LABELS, type HomeInput, type HomeSetup, type SavedHome } from "@/lib/customer/home-setup";
const field = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2 text-base";
const initial: HomeInput = { street: "", city: "", state: "TX", zip: "", bedrooms: 2, bathrooms: 2, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1 };
export function HomeSetupForm({ needsContact, demo }: { needsContact: boolean; demo: boolean }) {
  const [home, setHome] = useState(initial), [contact, setContact] = useState({ firstName: "", lastName: "", phone: "" });
  const [review, setReview] = useState<HomeSetup | null>(null), [saved, setSaved] = useState<SavedHome | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "uncertain" | "refused">("idle"), [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null), saving = useRef(false);
  useEffect(() => { if (review || saved) heading.current?.focus(); }, [review, saved]);
  async function save() {
    if (!review || saving.current || demo) return;
    saving.current = true; setState("saving"); setError("");
    try {
      const response = await fetch("/api/customer/homes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(review) });
      const result = await response.json();
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "Retry Save home to check the result.");
        setState(response.status >= 500 ? "uncertain" : "refused"); return;
      }
      setSaved(savedHome(result, review)); setState("idle");
    } catch { setState("uncertain"); setError("We could not confirm the save. Retry Save home with these same reviewed details."); }
    finally { saving.current = false; }
  }
  if (saved) return <section className="visit-feature mt-6">
    <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-navy">Home saved</h2>
    <p className="mt-3">{saved.home.street}<br />{saved.home.city}, {saved.home.state} {saved.home.zip}</p>
    <p className="mt-3 text-sm text-ink-2">Choose your clean and review the exact price before requesting a visit.</p>
    <Link href={`/customer/book?home=${encodeURIComponent(saved.id)}`} className="primary-action mt-5 inline-flex">Choose your clean</Link>
    <Link href={`/customer/account/homes/${encodeURIComponent(saved.id)}`} className="secondary-action mt-3 inline-flex">Add entry, parking and pet instructions</Link>
  </section>;
  if (review) return <section className="visit-feature mt-6">
    <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-navy">Review your home</h2>
    <p className="mt-3">{review.home.street}<br />{review.home.city}, {review.home.state} {review.home.zip}</p>
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{ROOM_FIELDS.map(k => <div key={k}><dt className="text-ink-2">{ROOM_LABELS[k]}</dt><dd className="font-semibold">{review.home[k]}</dd></div>)}</dl>
    {review.contact && <p className="mt-4 text-sm">Contact: {review.contact.firstName} {review.contact.lastName}<br />{review.contact.phone}</p>}
    <p className="mt-4 text-sm text-ink-2">Saving a home does not book a visit. Availability is confirmed after matching.</p>
    <button type="button" onClick={save} disabled={demo || state === "saving"} className="primary-action mt-5 min-h-11 w-full">{state === "saving" ? "Saving home…" : "Save home"}</button>
    {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
    {demo && <p className="mt-3 text-sm text-ink-2">Sample home details cannot be saved.</p>}
    <button type="button" disabled={state === "saving" || state === "uncertain"} className="secondary-action mt-3 min-h-11 w-full" onClick={() => { setReview(null); setState("idle"); setError(""); }}>Edit details</button>
    {state === "uncertain" && <p className="mt-3 text-sm text-ink-2">Keep these details unchanged while checking whether the save completed.</p>}
    <Link href="/customer/account/homes" className="mt-3 inline-flex min-h-11 items-center underline">Your homes</Link>
  </section>;
  return <form className="mt-6 max-w-xl" onSubmit={e => {
    e.preventDefault(); setError("");
    try { setReview(parseHomeSetup({ id: crypto.randomUUID(), home, contact: needsContact ? contact : null })); }
    catch (e) { setError(e instanceof Error ? e.message : "Check your home details."); }
  }}>
    {needsContact && <fieldset className="mb-6"><legend className="text-lg font-semibold text-navy">Your contact details</legend>
      {(["firstName", "lastName", "phone"] as const).map(k => <label key={k} className="mt-4 block text-sm font-semibold">{k === "firstName" ? "First name" : k === "lastName" ? "Last name" : "Phone for your visit"}<input required autoComplete={k === "firstName" ? "given-name" : k === "lastName" ? "family-name" : "tel"} type={k === "phone" ? "tel" : "text"} maxLength={k === "phone" ? 32 : 80} className={field} value={contact[k]} onChange={e => setContact({ ...contact, [k]: e.target.value })} /></label>)}
    </fieldset>}
    <fieldset><legend className="text-lg font-semibold text-navy">Home address</legend>
      {(["street", "city", "state", "zip"] as const).map(k => <label key={k} className="mt-4 block text-sm font-semibold">{k === "street" ? "Street address, including apartment or unit" : k === "city" ? "City" : k === "state" ? "State" : "ZIP code"}<input required autoComplete={k === "street" ? "street-address" : k === "city" ? "address-level2" : k === "state" ? "address-level1" : "postal-code"} maxLength={k === "street" ? 200 : k === "city" ? 100 : k === "state" ? 2 : 5} inputMode={k === "zip" ? "numeric" : undefined} className={field} value={home[k]} onChange={e => setHome({ ...home, [k]: e.target.value })} /></label>)}
    </fieldset>
    <fieldset className="mt-6"><legend className="text-lg font-semibold text-navy">Rooms to clean</legend><div className="grid grid-cols-2 gap-4">{ROOM_FIELDS.map(k => <label key={k} className="mt-4 block text-sm font-semibold">{ROOM_LABELS[k]}<input type="number" required min={0} max={k === "halfBaths" ? 4 : 8} step={1} className={field} value={Number.isNaN(home[k]) ? "" : home[k]} onChange={e => setHome({ ...home, [k]: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>)}</div></fieldset>
    {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
    <button type="submit" className="primary-action mt-6 min-h-11 w-full">Review home</button>
  </form>;
}
