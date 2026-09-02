/**
 * Money is integer cents everywhere — in the database, in the engines, on the
 * wire. Floats are never used for currency. Formatting happens at the edge.
 */

export type Cents = number;

export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Whole dollars, for dense tables where the cents are noise. */
export function formatDollars(cents: Cents): string {
  return `${cents < 0 ? "-" : ""}$${Math.round(Math.abs(cents) / 100).toLocaleString()}`;
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

export function formatPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Round to whole cents once, at the end of a calculation — never midway. */
export function toCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}
