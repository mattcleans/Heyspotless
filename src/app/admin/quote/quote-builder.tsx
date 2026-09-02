"use client";

import { useMemo, useState } from "react";
import {
  FREQUENCY_LABELS,
  PRICE_BOOK_EXTRAS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  type Frequency,
  type ServiceType,
  frequenciesForService,
} from "@/lib/pricing/price-book";
import { buildQuote } from "@/lib/pricing/quote";
import { OPENING_RATE_CENTS_PER_HOUR, payoutForRate } from "@/lib/dispatch/ladder";
import { formatCents, formatHours, formatPct } from "@/lib/money";

const COUNTS = [
  { key: "bedrooms", label: "Bedrooms", min: 0 },
  { key: "bathrooms", label: "Bathrooms", min: 0 },
  { key: "halfBaths", label: "Half baths", min: 0 },
  { key: "kitchens", label: "Kitchens", min: 0 },
  { key: "livingRooms", label: "Living / dining", min: 0 },
  { key: "utilityRooms", label: "Utility", min: 0 },
] as const;

type CountKey = (typeof COUNTS)[number]["key"];

export function QuoteBuilder() {
  const [service, setService] = useState<ServiceType>("standard");
  const [frequency, setFrequency] = useState<Frequency>("one_time");
  const [rooms, setRooms] = useState<Record<CountKey, number>>({
    bedrooms: 3,
    bathrooms: 2,
    halfBaths: 0,
    kitchens: 1,
    livingRooms: 1,
    utilityRooms: 1,
  });
  const [extras, setExtras] = useState<string[]>([]);

  const available = frequenciesForService(service);

  function pickService(next: ServiceType) {
    setService(next);
    // Deep is one-time/monthly only, Move In/Out is one-time only — snap the
    // frequency rather than letting the form request a price that doesn't exist.
    const allowed = frequenciesForService(next);
    if (!allowed.includes(frequency)) setFrequency(allowed[0] ?? "one_time");
  }

  const result = useMemo(() => {
    try {
      return {
        quote: buildQuote(service, frequency, rooms, extras.map((itemKey) => ({ itemKey }))),
        error: null as string | null,
      };
    } catch (e) {
      return { quote: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [service, frequency, rooms, extras]);

  const quote = result.quote;
  const offer = quote
    ? payoutForRate(OPENING_RATE_CENTS_PER_HOUR, quote.estimatedMinutes)
    : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <fieldset>
          <legend className="eyebrow mb-2">Service</legend>
          <div className="flex flex-wrap gap-2">
            {SERVICE_TYPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickService(s)}
                aria-pressed={service === s}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  service === s
                    ? "border-navy bg-navy text-white"
                    : "border-line bg-surface text-ink-2 hover:border-sky-deep"
                }`}
              >
                {SERVICE_LABELS[s]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="eyebrow mb-2">Frequency</legend>
          <div className="flex flex-wrap gap-2">
            {available.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFrequency(f)}
                aria-pressed={frequency === f}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  frequency === f
                    ? "border-navy bg-navy text-white"
                    : "border-line bg-surface text-ink-2 hover:border-sky-deep"
                }`}
              >
                {FREQUENCY_LABELS[f]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-3">
            The recurring discount is already inside these rates — it is never applied a second
            time.
          </p>
        </fieldset>

        <fieldset>
          <legend className="eyebrow mb-2">Rooms</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {COUNTS.map((c) => (
              <label key={c.key} className="block">
                <span className="text-xs text-ink-2">{c.label}</span>
                <input
                  type="number"
                  min={c.min}
                  value={rooms[c.key]}
                  onChange={(e) =>
                    setRooms((r) => ({
                      ...r,
                      [c.key]: Math.max(c.min, Number(e.target.value) || 0),
                    }))
                  }
                  className="nums mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm focus:border-sky-deep focus:outline-none"
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-3">
            A Zillow &ldquo;2.5 ba&rdquo; is 2 bathrooms + 1 half bath — never a fractional
            bathroom.
          </p>
        </fieldset>

        <fieldset>
          <legend className="eyebrow mb-2">Extras — flat, never discounted</legend>
          <div className="flex flex-wrap gap-2">
            {PRICE_BOOK_EXTRAS.map((x) => {
              const on = extras.includes(x.itemKey);
              return (
                <button
                  key={x.itemKey}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setExtras((cur) =>
                      cur.includes(x.itemKey)
                        ? cur.filter((k) => k !== x.itemKey)
                        : [...cur, x.itemKey],
                    )
                  }
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    on
                      ? "border-cream bg-cream-soft text-ink"
                      : "border-line bg-surface text-ink-2 hover:border-sky-deep"
                  }`}
                >
                  {x.name} · {formatCents(x.priceCents)}
                  {x.unitLabel === "flat" ? "" : ` / ${x.unitLabel.replace("per ", "")}`}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <aside className="card h-fit p-5 lg:sticky lg:top-6">
        {result.error ? (
          <p className="text-sm text-bad">{result.error}</p>
        ) : quote ? (
          <>
            <p className="eyebrow">Quote</p>
            <p className="nums mt-1 text-3xl leading-none font-semibold text-navy">
              {formatCents(quote.totalCents)}
            </p>
            <p className="mt-1.5 text-xs text-ink-3">
              about {formatHours(quote.estimatedMinutes)} of cleaning
            </p>

            <table className="mt-4 w-full text-xs">
              <tbody>
                {quote.lines.map((line) => (
                  <tr key={`${line.itemKey}-${line.isExtra}`} className="border-b border-line-soft last:border-0">
                    <td className="py-1.5 text-ink-2">
                      {line.name}
                      {line.quantity > 1 ? (
                        <span className="nums text-ink-3"> ×{line.quantity}</span>
                      ) : null}
                    </td>
                    <td className="nums py-1.5 text-right text-ink">
                      {formatCents(line.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 border-t border-line pt-3">
              <p className="eyebrow">Opening offer to a cleaner</p>
              <p className="nums mt-1 text-lg font-semibold text-ink">
                {formatCents(offer)}
                <span className="ml-1.5 text-xs font-normal text-ink-3">
                  for {formatHours(quote.estimatedMinutes)}
                </span>
              </p>
              <p className="mt-1 text-xs text-ink-3">
                {formatCents(OPENING_RATE_CENTS_PER_HOUR)}/hr ={" "}
                {formatPct(offer / quote.totalCents)} of this ticket. The rate is what stays
                flat; the percentage floats per job.
              </p>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
