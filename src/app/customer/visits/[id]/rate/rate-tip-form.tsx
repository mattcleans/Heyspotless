"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { tipPassThrough } from "@/lib/billing/tips";
import { customTipAmount } from "@/lib/billing/tip-input";
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";

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

export interface SavedRating {
  score: number;
  highlights: string[];
  privateNote: string | null;
}

export function RateTipForm({
  jobId,
  cleanerFirstName,
  cleanPriceCents,
  tipsEnabled,
  initialRating = null,
}: {
  jobId: string;
  cleanerFirstName: string;
  cleanPriceCents: number;
  tipsEnabled: boolean;
  initialRating?: SavedRating | null;
}) {
  const router = useRouter();
  const [score, setScore] = useState<number | null>(initialRating?.score ?? null);
  const [chosen, setChosen] = useState<string[]>(initialRating?.highlights ?? []);
  const [tipCents, setTipCents] = useState(0);
  const [customTip, setCustomTip] = useState("");
  const [note, setNote] = useState(initialRating?.privateNote ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [tipAddedCents, setTipAddedCents] = useState<number | null>(null);
  const [receiptNotice, setReceiptNotice] = useState<string | null>(null);
  const submission = useRef<{ key: string; id: string } | null>(null);

  const split = tipCents > 0 ? tipPassThrough(tipCents) : null;
  const customTipError = customTipAmount(customTip, cleanPriceCents).error;

  function toggle(key: string) {
    setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  }

  async function submit() {
    if (score === null || customTipError) return;
    setSending(true);
    setError(null);

    try {
      const requestPayload = {
        jobId, score, highlights: chosen, privateNote: note.trim() || null,
        tipCents: tipsEnabled ? tipCents : 0,
      };
      const key = JSON.stringify(requestPayload);
      let attempt = submission.current;
      if (!attempt || attempt.key !== key) {
        attempt = { key, id: crypto.randomUUID() };
        submission.current = attempt;
      }
      const response = await fetchWithTimeout("/api/visits/rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...requestPayload, requestId: attempt.id }),
      });

      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as {
        recorded?: unknown;
        error?: unknown;
        warning?: unknown;
        tip?: { tipCents?: unknown } | null;
      };

      if (data.recorded !== true) {
        setError(typeof data.error === "string" ? data.error : "That did not save.");
        return;
      }

      setTipAddedCents(
        typeof data.tip?.tipCents === "number" && data.tip.tipCents > 0
          ? data.tip.tipCents
          : null,
      );
      setReceiptNotice(
        typeof data.error === "string"
          ? data.error
          : typeof data.warning === "string"
            ? data.warning
            : null,
      );
      setDone(true);
      router.refresh();
    } catch {
      setError("We could not confirm whether your rating saved. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <RatingReceipt tipAddedCents={tipAddedCents} notice={receiptNotice} />
    );
  }

  return (
    <fieldset disabled={sending} aria-busy={sending} className="space-y-4">
      <legend className="sr-only">Rate this clean and choose an optional tip</legend>
      {initialRating && <p className="text-sm text-ink-2">
        Saved rating: {initialRating.score} out of 5. You can update it below.
      </p>}
      <div className="card p-5">
        <p className="text-center text-sm text-ink-2">How did {cleanerFirstName} do?</p>

        <div className="mt-3 flex justify-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} out of 5`}
              aria-pressed={score === n}
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
                  aria-pressed={chosen.includes(h.key)}
                  className={`min-h-11 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
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

          {tipsEnabled ? <div className="card p-5">
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
                aria-label="Custom tip in dollars"
                aria-invalid={Boolean(customTipError)}
                aria-describedby={customTipError ? "custom-tip-error" : undefined}
                inputMode="decimal"
                value={customTip}
                placeholder="Other"
                onChange={(e) => {
                  setCustomTip(e.target.value);
                  setTipCents(customTipAmount(e.target.value, cleanPriceCents).cents);
                }}
                className="w-20 rounded-lg border border-line bg-surface-2 px-2 text-center text-sm"
              />
            </div>

            {customTipError && <p id="custom-tip-error" role="alert" className="mt-2 text-sm text-bad">{customTipError}</p>}
            <p className="mt-2 text-xs text-ink-3">Tips are optional. Saving your rating alone keeps any tip already on your bill.</p>
            <button type="button" aria-pressed={tipCents === 0 && !customTip}
              className="mt-2 min-h-11 rounded-lg border border-line px-3 text-xs text-navy"
              onClick={() => { setTipCents(0); setCustomTip(""); }}>Save rating without changing tip</button>

            {split && split.tipCents > 0 ? (
              <p className="mt-2 text-xs text-ink-3">
                {cleanerFirstName} receives{" "}
                <span className="nums text-navy">{formatCents(split.netCents)}</span>
                {split.feeCents > 0 ? ` · card fee ${formatCents(split.feeCents)}` : ""}
              </p>
            ) : null}
          </div> : <p className="text-sm text-ink-2">Online tipping is unavailable. You can still save your rating.</p>}

          <div className="card p-5">
            <label htmlFor="rating-private-note" className="eyebrow">Private note</label>
            <p id="rating-note-privacy" className="mt-0.5 text-[11px] text-ink-3">
              Only our team sees this — it is never shown on a profile.
            </p>
            <textarea
              id="rating-private-note"
              aria-describedby="rating-note-privacy"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Anything we should know?"
              className="mt-2 w-full rounded-lg border border-line bg-surface-2 p-3 text-sm"
            />
          </div>

          {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}

          <button
            type="button"
            disabled={sending || Boolean(customTipError)}
            onClick={() => void submit()}
            className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {sending
              ? "Sending…"
              : tipCents > 0
                ? `Save rating and set tip to ${formatCents(tipCents)}`
                : initialRating ? "Update rating" : "Save rating"}
          </button>
        </>
      ) : null}
    </fieldset>
  );
}

export function RatingReceipt({ tipAddedCents, notice }: {
  tipAddedCents: number | null;
  notice: string | null;
}) {
  return <div className="card p-6 text-center">
    <p className="text-lg font-semibold text-navy">Thank you. Your rating is saved.</p>
    {tipAddedCents !== null && <p className="mt-2 text-sm text-ink-2">
      Your {formatCents(tipAddedCents)} tip was saved. Check Account for the latest bill and payment status.
    </p>}
    {notice && <p className="mt-2 text-sm text-bad" role="status">{notice}</p>}
    <Link href="/customer/account" className="secondary-action mt-4 inline-flex min-h-11 items-center">View account</Link>
  </div>;
}
