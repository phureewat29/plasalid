/**
 * Minor-unit (integer) money helpers: `transactions` stores amounts as
 * integers in the currency's smallest unit (THB satang, JPY has none, KWD has
 * three) to avoid float drift. Decimal <-> minor-unit conversion happens only
 * at the CLI/pipeline boundary.
 */

const exponentCache = new Map<string, number>();

/**
 * Fractional digits the currency's minor unit carries (THB=2, JPY=0, KWD=3),
 * resolved via Intl and memoized. Falls back to 2 on an unresolvable code —
 * including an empty/garbage code, which Intl rejects (matching THB's own
 * exponent of 2, so no local default currency is needed).
 */
export function minorUnitExponent(currency: string): number {
  const code = currency.toUpperCase();
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;

  let exp = 2;
  try {
    const resolved = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions();
    exp = resolved.maximumFractionDigits ?? 2;
  } catch {
    exp = 2;
  }
  exponentCache.set(code, exp);
  return exp;
}

/** Convert a decimal amount to integer minor units (THB 135.00 -> 13500). */
export function toMinorUnits(decimal: number, currency: string): number {
  return Math.round(decimal * 10 ** minorUnitExponent(currency));
}

/** Convert integer minor units back to a decimal amount (13500 -> 135.00). */
export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}
