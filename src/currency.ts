import { config } from "./config.js";

const DEFAULT_LOCALE = "th-TH";
const DEFAULT_CURRENCY = "THB";

export function getDisplayLocale(): string {
  return config.displayLocale || DEFAULT_LOCALE;
}

export function getDisplayCurrency(): string {
  return config.displayCurrency || DEFAULT_CURRENCY;
}

export function formatCurrencyAmount(
  amount: number,
  options: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    currency?: string;
  } = {},
): string {
  const locale = getDisplayLocale();
  const currency = options.currency || getDisplayCurrency();

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  }).format(Math.abs(amount));
}

export function formatAmount(amount: number, currency?: string): string {
  return formatCurrencyAmount(amount, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    currency,
  });
}

export function formatSignedAmount(amount: number, currency?: string): string {
  const body = formatAmount(amount, currency);
  return amount < 0 ? `-${body}` : body;
}

/**
 * Minor-unit (integer) money helpers.
 *
 * The TigerBeetle-style `transactions` table stores amounts as integers in the
 * currency's smallest indivisible unit ("minor units"): THB satang, USD cents,
 * JPY yen (no minor unit), KWD fils (three places). Storing money as integers
 * removes float drift from balance math. Decimal <-> minor-unit conversion
 * happens at the CLI/pipeline boundary; the DB query layer only ever sees
 * integers.
 */

const exponentCache = new Map<string, number>();

/**
 * Number of fractional digits the currency's minor unit carries (THB=2, JPY=0,
 * KWD=3). Resolved from the ICU currency data via Intl and memoized. Falls back
 * to 2 for a malformed/unresolvable code so callers never throw on bad input.
 */
export function minorUnitExponent(currency: string): number {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
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

/**
 * Localised currency string for an integer minor-unit amount, using the
 * currency's own fractional precision. Reuses `formatCurrencyAmount`; a leading
 * "-" is prepended for negative amounts (mirrors `formatSignedAmount`).
 */
export function formatMinorUnits(minor: number, currency?: string): string {
  const code = currency || getDisplayCurrency();
  const exp = minorUnitExponent(code);
  const body = formatCurrencyAmount(fromMinorUnits(minor, code), {
    currency: code,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  return minor < 0 ? `-${body}` : body;
}
