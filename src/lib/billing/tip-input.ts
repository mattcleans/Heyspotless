export function requestedTipCents(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 2_147_483_647 ? value : null;
}

/** Never turn a minus sign, exponent or malformed amount into a different tip. */
export function customTipAmount(value: string, priceCents: number): {
  cents: number; error: string | null;
} {
  const amount = value.trim();
  if (!amount) return { cents: 0, error: null };
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(amount)) {
    return { cents: 0, error: "Enter a dollar amount with up to two decimal places, such as 5.00." };
  }
  const [whole, fraction = ""] = amount.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  if (requestedTipCents(cents) === null || cents > priceCents) {
    return { cents: 0, error: "The tip cannot be more than the clean’s price." };
  }
  return { cents, error: null };
}
