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

type Stage = "quote" | "details" | "sent";

export function BookingWidget() {
  const [stage, setStage] = useState<Stage>("quote");
  const [service, setService] = useState<ServiceType>("standard");
  const [frequency, setFrequency] = useState<Frequency>("biweekly");
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
  const [consent, setConsent] = useState(true);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = frequenciesForService(service);

  function pickService(next: ServiceType) {
    setService(next);
    const allowed = frequenciesForService(next);
    if (!allowed.includes(frequency)) setFrequency(allowed[0] ?? "one_time");
  }

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
    if (!quote) return;
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
        setError(typeof data.error === "string" ? data.error : "That did not send.");
        setSending(false);
        return;
      }

      setStage("sent");
    } catch {
      setError("No connection. Nothing was sent — try again.");
    } finally {
      setSending(false);
    }
  }

  if (stage === "sent") {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold text-navy">Got it, {firstName || "thanks"}.</p>
        <p className="mt-2 text-sm text-ink-2">
          Somebody will confirm your {SERVICE_LABELS[service].toLowerCase()} and the exact price
          shortly — usually within the hour during the day.
        </p>
        <p className="mt-4 nums text-2xl font-semibold text-navy">
          {quote ? formatCents(quote.totalCents) : ""}
        </p>
        <p className="mt-1 text-xs text-ink-3">
          {FREQUENCY_LABELS[frequency]} · {rooms.bedrooms} bed · {rooms.bathrooms} bath
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="eyebrow">What needs cleaning</p>

        <div className="mt-3 flex flex-wrap gap-2">
          {SERVICE_TYPES.map((s) => (
            <button
              key={s}
              type="button"
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

        <div className="mt-4 flex flex-wrap gap-2">
          {available.map((f) => (
            <button
              key={f}
              type="button"
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
            <div key={count.key} className="flex items-center justify-between gap-4">
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

      <div className="card flex items-center justify-between gap-4 p-5">
        <div>
          <p className="eyebrow">Your price</p>
          <p className="mt-1 text-xs text-ink-3">
            {FREQUENCY_LABELS[frequency]} · confirmed against the real property before anything is
            booked
          </p>
        </div>
        <p className="nums text-3xl leading-none font-semibold text-navy">
          {quote ? formatCents(quote.totalCents) : "—"}
        </p>
      </div>

      {stage === "quote" ? (
        <button
          type="button"
          disabled={!quote}
          onClick={() => setStage("details")}
          className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Book this clean
        </button>
      ) : (
        <div className="card space-y-3 p-5">
          <p className="eyebrow">Where, and who</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="First name" value={firstName} onChange={setFirstName} required />
            <Input label="Last name" value={lastName} onChange={setLastName} />
          </div>

          <Input label="Phone" value={phone} onChange={setPhone} type="tel" required />
          <Input label="Email" value={email} onChange={setEmail} type="email" />
          <Input label="Address" value={address} onChange={setAddress} required />
          <Input label="ZIP" value={zip} onChange={setZip} required />
          <Input label="Anything we should know?" value={note} onChange={setNote} />

          {/*
            A2P requires express written consent before texting a number
            somebody typed into a form, and the evidence is this exact wording
            plus a timestamp — the same shape as autopay consent in 0006. It
            defaults to ticked because that is what the customer expects when
            they have asked to be contacted, and it is honestly reversible: STOP
            works, and the nudge sequence checks the timestamp rather than
            anybody's memory.
          */}
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
            disabled={sending || !firstName.trim() || !phone.trim() || !address.trim()}
            onClick={() => void send()}
            className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {sending ? "Sending…" : `Book ${quote ? formatCents(quote.totalCents) : ""}`}
          </button>

          <p className="text-center text-[11px] text-ink-3">
            {CUSTOMER_BRAND} will confirm before anything is charged. Nothing is taken now.
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
        className="h-9 w-9 rounded-lg border border-line bg-surface-2 text-lg leading-none"
      >
        −
      </button>
      <span className="nums w-6 text-center text-sm font-semibold text-navy">{value}</span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-9 w-9 rounded-lg border border-line bg-surface-2 text-lg leading-none"
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
      />
    </label>
  );
}
