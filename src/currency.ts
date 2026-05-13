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
  } = {},
): string {
  const locale = getDisplayLocale();
  const currency = getDisplayCurrency();

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  }).format(Math.abs(amount));
}
