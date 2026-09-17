"use client";

import { useState } from "react";
import { SCREEN_QUESTIONS } from "@/lib/recruiting/screen";
import { APPLICANT_SMS_CONSENT_TEXT } from "@/lib/growth/consent";

/**
 * The application form.
 *
 * TWO PAGES, AND THE SHORT ONE FIRST. Contact details and the facts dispatch
 * will check — transport, service area, insurance — then the written answers.
 * Somebody who abandons at the second page has still told us who they are and
 * whether they can be sent to a house, which is most of what the queue needs.
 *
 * The ZIPs are typed rather than picked from a map: the applicant knows where
 * she will drive better than a radius does, and a list she wrote is a list she
 * will stand behind when a job in one of them arrives.
 */

type Stage = "about" | "questions" | "sent";

export function ApplyForm() {
  const [stage, setStage] = useState<Stage>("about");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [years, setYears] = useState("");
  const [zips, setZips] = useState("");
  const [hasVehicle, setHasVehicle] = useState<boolean | null>(null);
  const [workAuthorized, setWorkAuthorized] = useState<boolean | null>(null);
  const [hasOwnInsurance, setHasOwnInsurance] = useState<boolean | null>(null);
  const [referral, setReferral] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(true);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
          email,
          yearsExperience: years ? Number(years) : null,
          serviceZips: zips
            .split(/[^0-9]+/)
            .map((z) => z.trim())
            .filter(Boolean),
          hasVehicle,
          workAuthorized,
          hasOwnInsurance,
          referralSource: referral,
          answers,
          smsConsent: consent,
        }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        const data = (payload ?? {}) as { error?: unknown };
        setError(typeof data.error === "string" ? data.error : "That did not send.");
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
      <div className="card mt-4 p-6 text-center">
        <p className="text-lg font-semibold text-navy">Thanks, {firstName}.</p>
        <p className="mt-2 text-sm text-ink-2">
          Somebody reads every application. If it looks like a fit we will text you about a
          background check — that is the only step that takes more than a day.
        </p>
      </div>
    );
  }

  const canContinue = firstName.trim() && phone.trim() && workAuthorized !== null;

  return (
    <div className="card mt-4 space-y-3 p-5">
      {stage === "about" ? (
        <>
          <p className="eyebrow">About you</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="First name" value={firstName} onChange={setFirstName} required />
            <Input label="Last name" value={lastName} onChange={setLastName} />
          </div>
          <Input label="Phone" value={phone} onChange={setPhone} type="tel" required />
          <Input label="Email" value={email} onChange={setEmail} type="email" />
          <Input
            label="Years of cleaning experience"
            value={years}
            onChange={setYears}
            type="number"
          />
          <Input
            label="ZIP codes you will work in"
            value={zips}
            onChange={setZips}
            placeholder="75024, 75025, 75093"
          />

          <YesNo label="Do you have your own transport?" value={hasVehicle} onChange={setHasVehicle} />
          <YesNo
            label="Are you authorised to work in the US?"
            value={workAuthorized}
            onChange={setWorkAuthorized}
            required
          />
          <YesNo
            label="Do you carry your own liability insurance?"
            value={hasOwnInsurance}
            onChange={setHasOwnInsurance}
            note="Not required to apply. It is required before your first job, and having it already is the difference between starting in a day and starting in a month."
          />

          <Input label="How did you hear about us?" value={referral} onChange={setReferral} />

          <button
            type="button"
            disabled={!canContinue}
            onClick={() => setStage("questions")}
            className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <p className="eyebrow">A few questions</p>
          <p className="text-xs text-ink-3">
            A person reads these. Short and specific beats long and general.
          </p>

          {SCREEN_QUESTIONS.map((question) => (
            <label key={question.key} className="block">
              <span className="text-sm text-ink">{question.prompt}</span>
              <textarea
                rows={question.rows}
                maxLength={2000}
                value={answers[question.key] ?? ""}
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, [question.key]: e.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-surface-2 p-3 text-sm"
              />
            </label>
          ))}

          <label className="flex items-start gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>{APPLICANT_SMS_CONSENT_TEXT}</span>
          </label>

          {error ? <p className="text-sm text-bad">{error}</p> : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStage("about")}
              className="rounded-lg border border-line px-4 py-3 text-sm font-medium text-ink-2"
            >
              Back
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void send()}
              className="flex-1 rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {sending ? "Sending…" : "Apply"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
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
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
      />
    </label>
  );
}

function YesNo({
  label,
  value,
  onChange,
  required = false,
  note,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  required?: boolean;
  note?: string;
}) {
  return (
    <div>
      <p className="text-xs text-ink-2">
        {label}
        {required ? " *" : ""}
      </p>
      <div className="mt-1 flex gap-2">
        {[true, false].map((option) => (
          <button
            key={String(option)}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-lg border px-4 py-1.5 text-sm transition-colors ${
              value === option
                ? "border-sky-deep bg-sky/20 text-navy"
                : "border-line bg-surface-2 text-ink-2 hover:border-sky-deep"
            }`}
          >
            {option ? "Yes" : "No"}
          </button>
        ))}
      </div>
      {note ? <p className="mt-1 text-[11px] leading-snug text-ink-3">{note}</p> : null}
    </div>
  );
}
