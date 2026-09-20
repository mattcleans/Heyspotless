"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { tipPassThrough } from "@/lib/billing/tips";

/**
 * Screen 7 — how did she do, and would you like to tip.
 *
 * THE TIP COPY IS THE HONEST VERSION. The design said "100% goes to Maria". It
 * is very nearly true and it is not quite: a card charge costs a percentage,
 * and the business may recover that and nothing else. So the screen says what
 * actually happens and shows her the figure — which is a better line anyway,
 * because it is checkable.
 *
 * Percentages are of the clean, not of the total: tipping 20% of a bill that
 * already includes last month's balance is not what anybody means.
 */

const HIGHLIGHTS = [
  { key: "on_time", label: "On time" },
  { key: "thorough", label: "Thorough" },
  { key: "great_with_pets", label: "Great with pets" },
  { key: "communicated_well", label: "Communicated well" },
  { key: "went_above", label: "Went above and beyond" },
] as const;

const TIP_PERCENTAGES = [0.15, 0.2, 0.25] as const;

export function RateTipForm({
  jobId,
  cleanerFirstName,
  cleanPriceCents,
}: {
  jobId: string;
  cleanerFirstName: string;
  cleanPriceCents: number;
}) {
  const router = useRouter();
  const [score, setScore] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [tipCents, setTipCents] = useState(0);
  const [customTip, setCustomTip] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const split = tipCents > 0 ? tipPassThrough(tipCents) : null;

  function toggle(key: string) {
    setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  }

  async function submit() {
    if (score === null) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch("/api/visits/rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId,
          score,
          highlights: chosen,
          privateNote: note.trim() || null,
          tipCents,
        }),
      });

      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as { recorded?: unknown; error?: unknown };

      if (!response.ok && data.recorded !== true) {
        setError(typeof data.error === "string" ? data.error : "That did not save.");
        return;
      }

      setDone(true);
      router.refresh();
    } catch {
      setError("No connection. Nothing was sent — try again.");
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold text-navy">Thank you.</p>
        <p className="mt-2 text-sm text-ink-2">
          {split
            ? `${cleanerFirstName} will get ${formatCents(split.netCents)} of your ${formatCents(split.tipCents)} tip — the rest is the card fee.`
            : `${cleanerFirstName} will see your rating.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-center text-sm text-ink-2">How did {cleanerFirstName} do?</p>

        <div className="mt-3 flex justify-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} out of 5`}
              onClick={() => setScore(n)}
              className={`flex-1 rounded-lg border py-4 text-2xl transition-colors ${
                score !== null && n <= score
                  ? "border-sky-deep bg-sky/20"
                  : "border-line bg-surface-2 hover:border-sky-deep"
              }`}
            >
              {score !== null && n <= score ? "★" : "☆"}
            </button>
          ))}
        </div>
      </div>

      {score !== null ? (
        <>
          <div className="card p-5">
            <p className="eyebrow">What stood out</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {HIGHLIGHTS.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  onClick={() => toggle(h.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    chosen.includes(h.key)
                      ? "border-sky-deep bg-sky/20 text-navy"
                      : "border-line bg-surface-2 text-ink-2"
                  }`}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-baseline justify-between">
              <p className="eyebrow">Add a tip</p>
              <p className="text-[11px] text-ink-3">
                Goes to {cleanerFirstName}, less the card fee
              </p>
            </div>

            <div className="mt-2 flex gap-1.5">
              {TIP_PERCENTAGES.map((pct) => {
                const cents = Math.round(cleanPriceCents * pct);
                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      setTipCents(cents);
                      setCustomTip("");
                    }}
                    className={`flex-1 rounded-lg border py-2.5 text-sm transition-colors ${
                      tipCents === cents && !customTip
                        ? "border-sky-deep bg-sky/20 text-navy"
                        : "border-line bg-surface-2 text-ink-2"
                    }`}
                  >
                    <span className="block font-semibold">{Math.round(pct * 100)}%</span>
                    <span className="nums block text-[11px] text-ink-3">
                      {formatCents(cents)}
                    </span>
                  </button>
                );
              })}
              <input
                inputMode="decimal"
                value={customTip}
                placeholder="Other"
                onChange={(e) => {
                  setCustomTip(e.target.value);
                  const dollars = Number(e.target.value.replace(/[^0-9.]/g, ""));
                  setTipCents(Number.isFinite(dollars) ? Math.round(dollars * 100) : 0);
                }}
                className="w-20 rounded-lg border border-line bg-surface-2 px-2 text-center text-sm"
              />
            </div>

            {split && split.tipCents > 0 ? (
              <p className="mt-2 text-xs text-ink-3">
                {cleanerFirstName} receives{" "}
                <span className="nums text-navy">{formatCents(split.netCents)}</span>
                {split.feeCents > 0 ? ` · card fee ${formatCents(split.feeCents)}` : ""}
              </p>
            ) : null}
          </div>

          <div className="card p-5">
            <p className="eyebrow">Private note</p>
            <p className="mt-0.5 text-[11px] text-ink-3">
              Only our team sees this — it is never shown on a profile.
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Anything we should know?"
              className="mt-2 w-full rounded-lg border border-line bg-surface-2 p-3 text-sm"
            />
          </div>

          {error ? <p className="text-sm text-bad">{error}</p> : null}

          <button
            type="button"
            disabled={sending}
            onClick={() => void submit()}
            className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {sending
              ? "Sending…"
              : tipCents > 0
                ? `Submit and tip ${formatCents(tipCents)}`
                : "Submit"}
          </button>
        </>
      ) : null}
    </div>
  );
}
