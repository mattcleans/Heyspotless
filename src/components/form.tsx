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

export function Select({
  name,
  label,
  options,
  errors,
  hint,
  value,
  onChange,
  defaultValue,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  errors?: Errors;
  hint?: string;
  /** Controlled when given — the service picker narrows the frequency picker. */
  value?: string;
  onChange?: (value: string) => void;
  defaultValue?: string;
}) {
  const error = errors?.[name];
  return (
    <label className="block">
      <span className="text-xs text-ink-2">{label}</span>
      <select
        name={name}
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={`${INPUT} ${error ? "border-bad" : "border-line"}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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

/**
 * A checkbox with its explanation attached.
 *
 * The label is the thing being switched on; the hint is what it will actually
 * do. For a control that starts a standing commitment — a recurring plan
 * against somebody's card — "what will happen" is not optional detail.
 */
export function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
  checked,
  onChange,
  errors,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  errors?: Record<string, string>;
}) {
  const error = errors?.[name];

  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          checked={checked}
          onChange={onChange ? (e) => onChange(e.currentTarget.checked) : undefined}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-navy"
        />
        <span>
          <span className="text-sm font-medium text-ink">{label}</span>
          {hint ? <span className="mt-0.5 block text-xs text-ink-3">{hint}</span> : null}
        </span>
      </label>
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : null}
    </div>
  );
}
