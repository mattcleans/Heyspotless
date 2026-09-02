import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-7">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">{title}</h1>
      {children ? <div className="mt-2 max-w-2xl text-sm text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    default: "text-navy",
    good: "text-good",
    warn: "text-warn",
    bad: "text-bad",
  }[tone];

  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`nums mt-1.5 text-2xl leading-none font-semibold ${toneClass}`}>{value}</p>
      {note ? <p className="mt-1.5 text-xs leading-snug text-ink-3">{note}</p> : null}
    </div>
  );
}

const PILL_TONES = {
  good: "border-good/40 bg-good/8 text-good",
  warn: "border-warn/40 bg-warn/8 text-warn",
  bad: "border-bad/40 bg-bad/8 text-bad",
  neutral: "border-line bg-surface-2 text-ink-2",
  sky: "border-sky-deep/40 bg-sky/15 text-navy",
} as const;

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof PILL_TONES;
}) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider uppercase ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Callout({
  tone = "warn",
  label,
  children,
}: {
  tone?: "good" | "warn" | "bad";
  label: string;
  children: ReactNode;
}) {
  const border = { good: "border-l-good", warn: "border-l-warn", bad: "border-l-bad" }[tone];
  const text = { good: "text-good", warn: "text-warn", bad: "text-bad" }[tone];
  return (
    <div className={`card border-l-4 p-4 ${border}`}>
      <p className={`font-mono text-[10px] font-semibold tracking-widest uppercase ${text}`}>
        {label}
      </p>
      <div className="mt-1.5 text-sm text-ink-2">{children}</div>
    </div>
  );
}
