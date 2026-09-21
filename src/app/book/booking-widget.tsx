"use client";

import { useMemo, useState } from "react";
import {
  FREQUENCY_LABELS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  type Frequency,
  type ServiceType,
  frequenciesForService,
} from "@/lib/pricing/price-book";
import { buildQuote } from "@/lib/pricing/quote";
import { bestFrequencySaving, frequencySaving } from "@/lib/pricing/discount";
import { formatCents } from "@/lib/money";
import { CUSTOMER_BRAND } from "@/lib/brand";
import { SMS_CONSENT_TEXT } from "@/lib/growth/consent";

/**
 * The price, before the form.
 *
 * WHY THE NUMBER COMES FIRST. Every competitor in DFW answers "how much?" with
 * "fill in this form and we'll get back to you", and the build plan's largest
 * single lever is the lead conversion that costs — marketing at ~33% of revenue
 * against a 15% target, about $24,000 a year. A homeowner who gets a real
 * number in four seconds has no reason to fill in the next three forms.
 *
 * It is the SAME `buildQuote` the office uses and the same one recurring plans
 * are generated from. That is the whole reason it is a pure function: a widget
 * with its own pricing table is how the Housecall Pro Services book and the
 * pricing forms drifted apart in the first place.
 *
 * WHAT IT DOES NOT DO. It does not book. The room counts are what somebody
 * typed on a phone, and a stranger dropped straight into Thursday on unverified
 * inputs is a cleaner's wasted afternoon. So it quotes honestly, says the price
 * is subject to the real property, and hands the office a lead that already has
 * a number on it.
 */

const COUNTS = [
  { key: "bedrooms", label: "Bedrooms", max: 8 },
  { key: "bathrooms", label: "Full baths", max: 8 },
  { key: "halfBaths", label: "Half baths", max: 4 },
] as const;

type CountKey = (typeof COUNTS)[number]["key"];

type Stage = "quote" | "details" | "review" | "sent";

export function BookingWidget({
  initialService = "standard",
  demo = false,
}: {
  initialService?: ServiceType;
  demo?: boolean;
}) {
  const [stage, setStage] = useState<Stage>("quote");
  const [service, setService] = useState<ServiceType>(initialService);
  const [frequency, setFrequency] = useState<Frequency>(
    initialService === "standard" ? "biweekly" : "one_time",
  );
  const [rooms, setRooms] = useState<Record<CountKey, number>>({
    bedrooms: 3,
    bathrooms: 2,
    halfBaths: 0,
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [zip, setZip] = useState("");
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = frequenciesForService(service);

  function pickService(next: ServiceType) {
    setService(next);
    const allowed = frequenciesForService(next);
    if (!allowed.includes(frequency)) setFrequency(allowed[0] ?? "one_time");
  }

  /**
   * What committing to a schedule saves, against the one-time rate.
   *
   * DERIVED, NEVER STORED. The price book holds a rate per (item, frequency) —
   * there is no discount column anywhere — so the saving is the difference
   * between two quotes for the same house. It can therefore never disagree
   * with the price, and it is about THEIR rooms rather than a marketing figure
   * that may not apply to them.
   */
  const saving = useMemo(() => {
    const counts = { ...rooms, kitchens: 1, livingRooms: 1, utilityRooms: 1 };
    return frequencySaving(service, frequency, counts);
  }, [service, frequency, rooms]);

  const bestSaving = useMemo(() => {
    const counts = { ...rooms, kitchens: 1, livingRooms: 1, utilityRooms: 1 };
    return bestFrequencySaving(service, counts);
  }, [service, rooms]);

  const quote = useMemo(() => {
    try {
      return buildQuote(service, frequency, {
        ...rooms,
        kitchens: 1,
        livingRooms: 1,
        utilityRooms: 1,
      });
    } catch {
      return null;
    }
  }, [service, frequency, rooms]);

  async function send() {
    if (!quote || demo || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          address,
          zip,
          note,
          service,
          frequency,
          rooms,
          smsConsent: consent,
          // What the customer was actually shown. The server re-prices from the
          // same inputs rather than trusting it — a total in a request body is
          // a discount anybody can grant themselves.
          shownTotalCents: quote.totalCents,
        }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        const data = (payload ?? {}) as { error?: unknown };
        setError(
          typeof data.error === "string" ? data.error : "That did not send.",
        );
        setSending(false);
        return;
      }

      setStage("sent");
    } catch {
      setError(
        "We could not confirm receipt. Please call 469-280-0397 before trying again.",
      );
    } finally {
      setSending(false);
    }
  }

  if (stage === "sent") {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold text-navy">
          Got it, {firstName || "thanks"}.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Somebody will confirm your {SERVICE_LABELS[service].toLowerCase()} and
          the exact price with you. Your visit is not booked until we confirm
          the date, time, and price.
        </p>
        <p className="mt-4 nums text-2xl font-semibold text-navy">
          {quote ? formatCents(quote.totalCents) : ""}
        </p>
        <p className="mt-1 text-xs text-ink-3">
          {FREQUENCY_LABELS[frequency]} · {rooms.bedrooms} bed ·{" "}
          {rooms.bathrooms} bath
        </p>
      </div>
    );
  }

  if (stage === "review") {
    return (
      <section className="visit-feature" aria-labelledby="review-title">
        <p className="text-sm text-ink-2">Step 3 of 3</p>
        <h2 id="review-title" className="mt-2 text-xl font-semibold text-navy">
          Review your request
        </h2>
        <dl className="mt-5 space-y-4 text-sm">
          <div>
            <dt className="text-ink-2">Your clean</dt>
            <dd className="mt-1 font-semibold">
              {SERVICE_LABELS[service]} · {FREQUENCY_LABELS[frequency]}
            </dd>
            <dd>
              {rooms.bedrooms} bedrooms, {rooms.bathrooms} full baths,{" "}
              {rooms.halfBaths} half baths
            </dd>
          </div>
          <div>
            <dt className="text-ink-2">Your home</dt>
            <dd className="mt-1">
              {address}, {zip}
            </dd>
          </div>
          <div>
            <dt className="text-ink-2">Contact</dt>
            <dd className="mt-1">
              {firstName} {lastName}
            </dd>
            <dd>{phone}</dd>
            {email && <dd>{email}</dd>}
          </div>
          {note && (
            <div>
              <dt className="text-ink-2">Your notes</dt>
              <dd className="mt-1 whitespace-pre-wrap">{note}</dd>
            </div>
          )}
          <div>
            <dt className="text-ink-2">Text updates</dt>
            <dd>
              {consent
                ? "You opted in to booking texts."
                : "No text updates requested."}
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-4">
            <dt>Estimated visit price</dt>
            <dd className="text-xl font-semibold text-navy">
              {quote ? formatCents(quote.totalCents) : "Not available"}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-ink-2">
          This requests a clean. Our team will confirm your time, cleaner, and
          final price. No appointment is reserved and no payment is taken now.
        </p>
        {error && (
          <p role="alert" className="mt-4 text-sm text-bad">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={sending || demo || !quote}
          onClick={() => void send()}
          className="primary-action mt-5 w-full disabled:opacity-50"
        >
          {demo
            ? "Preview only, sending is off"
            : sending
              ? "Sending request…"
              : "Send my request"}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => {
            setStage("details");
            setError(null);
          }}
          className="secondary-action mt-3 w-full"
        >
          Edit my details
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        {stage === "quote"
          ? "Step 1 of 3: Your home & service"
          : "Step 2 of 3: Your details"}
      </p>
      <div className="card p-5">
        <p className="eyebrow">What needs cleaning</p>

        <div className="mt-3 flex flex-wrap gap-2">
          {SERVICE_TYPES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === service}
              onClick={() => pickService(s)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                s === service
                  ? "border-sky-deep bg-sky/20 text-navy"
                  : "border-line bg-surface-2 text-ink-2 hover:border-sky-deep"
              }`}
            >
              {SERVICE_LABELS[s]}
            </button>
          ))}
        </div>

        {bestSaving ? (
          <p className="mt-4 text-xs font-medium text-good">
            Save up to {formatCents(bestSaving.savingCents)} a clean when it
            repeats
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap gap-2">
          {available.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={f === frequency}
              onClick={() => setFrequency(f)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                f === frequency
                  ? "border-sky-deep bg-sky/20 text-navy"
                  : "border-line bg-surface-2 text-ink-2 hover:border-sky-deep"
              }`}
            >
              {FREQUENCY_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-3">
          {COUNTS.map((count) => (
            <div
              key={count.key}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-sm text-ink">{count.label}</span>
              <Stepper
                value={rooms[count.key]}
                max={count.max}
                onChange={(n) => setRooms((r) => ({ ...r, [count.key]: n }))}
                label={count.label}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="eyebrow">Your estimate</p>
            <p className="mt-1 text-xs text-ink-3">
              {FREQUENCY_LABELS[frequency]} · confirmed against the real
              property before anything is booked
            </p>
          </div>
          <p className="nums text-3xl leading-none font-semibold text-navy">
            {quote ? formatCents(quote.totalCents) : "Unavailable"}
          </p>
        </div>

        {saving ? (
          <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between text-ink-3">
              <dt>One-time price</dt>
              <dd className="nums line-through">
                {formatCents(saving.oneTimeCents)}
              </dd>
            </div>
            <div className="flex justify-between font-medium text-good">
              <dt>{FREQUENCY_LABELS[frequency]} saving</dt>
              <dd className="nums">−{formatCents(saving.savingCents)}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      {stage === "quote" ? (
        <button
          type="button"
          disabled={!quote}
          onClick={() => setStage("details")}
          className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Continue to my details
        </button>
      ) : (
        <div className="card space-y-3 p-5">
          <p className="eyebrow">Where, and who</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="First name"
              value={firstName}
              onChange={setFirstName}
              required
            />
            <Input label="Last name" value={lastName} onChange={setLastName} />
          </div>

          <Input
            label="Phone"
            value={phone}
            onChange={setPhone}
            type="tel"
            required
          />
          <Input label="Email" value={email} onChange={setEmail} type="email" />
          <Input
            label="Address"
            value={address}
            onChange={setAddress}
            required
          />
          <Input label="ZIP" value={zip} onChange={setZip} required />
          <Input
            label="Anything we should know?"
            value={note}
            onChange={setNote}
          />

          {/* Customers explicitly choose whether to receive text updates. */}
          <label className="flex items-start gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>{SMS_CONSENT_TEXT}</span>
          </label>

          {error ? <p className="text-sm text-bad">{error}</p> : null}

          <button
            type="button"
            disabled={
              !firstName.trim() ||
              !phone.trim() ||
              !address.trim() ||
              !/^\d{5}$/.test(zip.trim())
            }
            onClick={() => setStage("review")}
            className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Review my request
          </button>

          <p className="text-center text-[11px] text-ink-3">
            {CUSTOMER_BRAND} will confirm before anything is charged. Nothing is
            taken now.
          </p>
        </div>
      )}
    </div>
  );
}

function Stepper({
  value,
  max,
  onChange,
  label,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`One fewer ${label}`}
        onClick={() => onChange(Math.max(0, value - 1))}
        className="h-11 w-11 rounded-lg border border-line bg-surface-2 text-lg leading-none"
      >
        −
      </button>
      <span className="nums w-6 text-center text-sm font-semibold text-navy">
        {value}
      </span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-11 w-11 rounded-lg border border-line bg-surface-2 text-lg leading-none"
      >
        +
      </button>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-2">
        {label}
        {required ? " *" : ""}
      </span>
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
      />
    </label>
  );
}
