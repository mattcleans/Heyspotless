"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  PRICE_BOOK_EXTRAS,
  SERVICE_TYPES,
  SERVICE_LABELS,
  FREQUENCY_LABELS,
  frequenciesForService,
  type ServiceType,
  type Frequency,
} from "@/lib/pricing/price-book";
import { formatCents } from "@/lib/money";
import { toClientQuote, type ClientQuote } from "@/lib/quotes/types";
import { QuoteCard } from "./quote-card";
type Home = {
  id: string;
  street: string;
  city: string;
  rooms: {
    bedrooms: number;
    bathrooms: number;
    halfBaths?: number;
    kitchens?: number;
    livingRooms?: number;
    utilityRooms?: number;
  };
};
export function PrepareQuote({
  homes,
  demo,
  defaultExpiry,
  savedIds,
}: {
  homes: Home[];
  demo: boolean;
  defaultExpiry: string;
  savedIds: string[];
}) {
  const [propertyId, setProperty] = useState(homes[0]?.id ?? ""),
    [service, setService] = useState<ServiceType>("standard"),
    [frequency, setFrequency] = useState<Frequency>("one_time"),
    [repeats, setRepeats] = useState(false),
    [start, setStart] = useState(""),
    [expires, setExpires] = useState(defaultExpiry),
    [note, setNote] = useState(""),
    [extras, setExtras] = useState<Record<string, number>>({}),
    [pending, setPending] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [quote, setQuote] = useState<ClientQuote | null>(null),
    [refresh, setRefresh] = useState(false);
  const router = useRouter(),
    home = homes.find((p) => p.id === propertyId);
  async function prepare(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setPending(body);
    try {
      const r = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await r.json();
      if (!r.ok) {
        setError(
          typeof (data as { error?: unknown })?.error === "string"
            ? (data as { error: string }).error
            : "Could not confirm quote preparation.",
        );
        if ([400, 401, 403, 409].includes(r.status)) {
          setPending(null);
          setRefresh(r.status !== 400);
        }
        return;
      }
      const q = toClientQuote(data);
      if (q.id !== body.id || q.propertyId !== body.propertyId)
        throw new Error("Wrong quote");
      setQuote(q);
      setPending(null);
      router.refresh();
    } catch {
      setError(
        "Could not confirm quote preparation. Retry this request to recover the same quote.",
      );
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || !!pending || !!quote || refresh;
  return (
    <section className="mt-6 max-w-2xl" aria-labelledby="prepare-quote">
      <h2 id="prepare-quote" className="text-xl font-semibold text-navy">
        Prepare a client quote
      </h2>
      <p className="mt-2 text-sm text-ink-2">
        Review the saved home first. Preparing a quote saves a private office
        review. Publish it after checking the exact price and appointment.
      </p>
      {!homes.length ? (
        <p className="mt-4 text-sm">
          Add a home on the client page before preparing a quote.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (locked || demo) return;
            void prepare({
              action: "prepare",
              id: crypto.randomUUID(),
              propertyId,
              service,
              frequency,
              start,
              expires,
              repeats,
              extras: Object.entries(extras)
                .filter(([, q]) => q > 0)
                .map(([itemKey, quantity]) => ({ itemKey, quantity })),
              note,
            });
          }}
          className="mt-5 space-y-5"
        >
          <fieldset disabled={locked || demo} className="space-y-5">
            <label className="block text-sm font-medium">
              Home
              <select
                className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 w-full"
                value={propertyId}
                onChange={(e) => setProperty(e.target.value)}
              >
                {homes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.street}, {p.city}
                  </option>
                ))}
              </select>
            </label>
            {home && (
              <p className="text-sm text-ink-2">
                Saved rooms: {home.rooms.bedrooms} bedrooms,{" "}
                {home.rooms.bathrooms} bathrooms, {home.rooms.halfBaths ?? 0}{" "}
                half baths, {home.rooms.kitchens ?? 1} kitchens,{" "}
                {home.rooms.livingRooms ?? 1} living rooms and{" "}
                {home.rooms.utilityRooms ?? 1} utility rooms.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Service
                <select
                  className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 w-full"
                  value={service}
                  onChange={(e) => {
                    const s = e.target.value as ServiceType;
                    setService(s);
                    setFrequency("one_time");
                    setRepeats(false);
                  }}
                >
                  {SERVICE_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {SERVICE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium">
                Price frequency
                <select
                  className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 w-full"
                  value={frequency}
                  onChange={(e) => {
                    const f = e.target.value as Frequency;
                    setFrequency(f);
                    if (f === "one_time") setRepeats(false);
                  }}
                >
                  {frequenciesForService(service).map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {frequency !== "one_time" && (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={repeats}
                  onChange={(e) => setRepeats(e.target.checked)}
                />
                Create a {FREQUENCY_LABELS[frequency].toLowerCase()} recurring
                schedule when booked
              </label>
            )}
            <label className="block text-sm font-medium">
              Proposed first appointment · Dallas time
              <input
                className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 w-full"
                type="datetime-local"
                step="60"
                required
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (e.target.value && expires > e.target.value) {
                    setExpires(e.target.value);
                  }
                }}
              />
            </label>
            <label className="block text-sm font-medium">
              Quote expires · Dallas time
              <input
                className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 w-full"
                type="datetime-local"
                step="60"
                required
                max={start || undefined}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
              <span className="mt-1 block font-normal text-ink-2">
                Choose a future expiry before the proposed appointment.
              </span>
            </label>
            <fieldset>
              <legend className="text-sm font-semibold">
                Extras {repeats ? "on every visit" : ""}
              </legend>
              <div className="mt-2 space-y-3">
                {PRICE_BOOK_EXTRAS.map((e) => (
                  <label
                    key={e.itemKey}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>
                      {e.name} · {formatCents(e.priceCents)} {e.unitLabel}
                    </span>
                    <input
                      aria-label={`${e.name} quantity`}
                      className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy w-20 shrink-0"
                      type="number"
                      min="0"
                      max="20"
                      step="1"
                      value={extras[e.itemKey] ?? 0}
                      onChange={(v) =>
                        setExtras({
                          ...extras,
                          [e.itemKey]: Number(v.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block text-sm font-medium">
              Note shown to the client
              <textarea
                className="min-h-11 min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-navy mt-2 min-h-24 w-full"
                maxLength={1500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <span className="mt-1 block font-normal text-ink-2">
                Keep internal office notes on the client record.
              </span>
            </label>
          </fieldset>
          {!quote && (
            <button
              className="primary-action"
              disabled={locked || demo}
              type="submit"
            >
              {busy ? "Preparing…" : "Prepare exact quote"}
            </button>
          )}
        </form>
      )}
      {error && (
        <p className="mt-4 text-sm" role="alert">
          {error}
        </p>
      )}
      {pending && !busy && (
        <button
          className="primary-action mt-4"
          onClick={() => void prepare(pending)}
        >
          Retry this quote request
        </button>
      )}
      {refresh && (
        <button
          className="secondary-action mt-4"
          onClick={() => router.refresh()}
        >
          Refresh quotes before continuing
        </button>
      )}
      {demo && (
        <p className="mt-4 text-sm">
          Sample home. Preparing real quotes requires a connected client
          account.
        </p>
      )}
      {quote &&
        (savedIds.includes(quote.id) ? (
          <p role="status" className="mt-5 text-sm">
            Quote prepared.{" "}
            <a href={`#quote-${quote.id}`} className="underline">
              Review the saved quote below
            </a>
            .
          </p>
        ) : (
          <QuoteCard quote={quote} role="admin" />
        ))}
      {quote && (
        <button
          className="secondary-action mt-4"
          onClick={() => {
            setQuote(null);
            setError("");
          }}
        >
          Prepare another quote
        </button>
      )}
    </section>
  );
}
