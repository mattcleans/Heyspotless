import type { ReactNode } from "react";

/**
 * Form primitives, matching the inputs already in the quote builder.
 *
 * The error handling is the part worth noting: every field takes its message
 * from the same `errors` map that validate.ts returns, so a field is shown as
 * wrong in exactly the cases the pure validator says it is, and there is no
 * second opinion in the UI to drift out of step with the first.
 */
export type Errors = Record<string, string>;

const INPUT =
  "mt-1 w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm " +
  "focus:outline-none focus:border-sky-deep";

export function Field({
  name,
  label,
  errors,
  hint,
  defaultValue,
  type = "text",
  required,
  placeholder,
  inputMode,
}: {
  name: string;
  label: string;
  errors?: Errors;
  hint?: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  placeholder?: string;
  inputMode?: "numeric" | "tel" | "email";
}) {
  const error = errors?.[name];
  return (
    <label className="block">
      <span className="text-xs text-ink-2">
        {label}
        {required ? <span className="text-bad"> *</span> : null}
      </span>
      <input
        name={name}
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        defaultValue={defaultValue ?? undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={`${INPUT} ${error ? "border-bad" : "border-line"} ${
          inputMode === "numeric" ? "nums" : ""
        }`}
      />
      {error ? (
        <span id={`${name}-error`} className="mt-1 block text-xs text-bad">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextArea({
  name,
  label,
  errors,
  hint,
  defaultValue,
  rows = 2,
}: {
  name: string;
  label: string;
  errors?: Errors;
  hint?: string;
  defaultValue?: string | null;
  rows?: number;
}) {
  const error = errors?.[name];
  return (
    <label className="block">
      <span className="text-xs text-ink-2">{label}</span>
      <textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? undefined}
        className={`${INPUT} ${error ? "border-bad" : "border-line"}`}
      />
      {error ? (
        <span className="mt-1 block text-xs text-bad">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

export function SubmitButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="submit"
      className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep"
    >
      {children}
    </button>
  );
}

/** Shown above a form when something failed that is not one field's fault. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="card border-l-4 border-l-bad p-3">
      <p className="text-sm text-bad">{message}</p>
    </div>
  );
}
