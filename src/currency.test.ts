import { afterEach, describe, expect, it } from "vitest";
import { config } from "./config.js";
import {
  formatCurrencyAmount,
  getDisplayCurrency,
  getDisplayLocale,
  minorUnitExponent,
  toMinorUnits,
  fromMinorUnits,
} from "./currency.js";

const ORIGINAL_LOCALE = config.displayLocale;
const ORIGINAL_CURRENCY = config.displayCurrency;

describe("currency helpers", () => {
  afterEach(() => {
    config.displayLocale = ORIGINAL_LOCALE;
    config.displayCurrency = ORIGINAL_CURRENCY;
  });

  it("defaults to Thai locale and THB", () => {
    config.displayLocale = "";
    config.displayCurrency = "";
    expect(getDisplayLocale()).toBe("th-TH");
    expect(getDisplayCurrency()).toBe("THB");
  });

  it("respects explicit overrides", () => {
    config.displayLocale = "en-US";
    config.displayCurrency = "USD";
    expect(getDisplayLocale()).toBe("en-US");
    expect(getDisplayCurrency()).toBe("USD");
  });

  it("formats THB amounts with the Thai locale", () => {
    config.displayLocale = "th-TH";
    config.displayCurrency = "THB";
    const formatted = formatCurrencyAmount(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatted).toMatch(/1,234\.50/);
    expect(formatted).toMatch(/฿|THB/);
  });
});

describe("minorUnitExponent", () => {
  it("resolves known currencies", () => {
    expect(minorUnitExponent("THB")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(minorUnitExponent("thb")).toBe(2);
    expect(minorUnitExponent("jpy")).toBe(0);
  });

  it("falls back to 2 for a malformed / empty code", () => {
    expect(minorUnitExponent("not-a-currency")).toBe(2);
    expect(minorUnitExponent("")).toBe(2);
  });
});

describe("toMinorUnits / fromMinorUnits", () => {
  it("converts decimals to minor units per the currency exponent", () => {
    expect(toMinorUnits(135.0, "THB")).toBe(13500);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("rounds to the nearest minor unit", () => {
    expect(toMinorUnits(135.005, "THB")).toBe(13501);
    expect(toMinorUnits(135.004, "THB")).toBe(13500);
  });

  it("round-trips decimal -> minor -> decimal", () => {
    expect(fromMinorUnits(toMinorUnits(135.0, "THB"), "THB")).toBe(135);
    expect(fromMinorUnits(toMinorUnits(1500, "JPY"), "JPY")).toBe(1500);
    expect(fromMinorUnits(toMinorUnits(1.234, "KWD"), "KWD")).toBe(1.234);
  });

  it("respects each currency's own fractional precision (THB=2, JPY=0)", () => {
    expect(toMinorUnits(135.0, "THB")).toBe(13500);
    expect(fromMinorUnits(13500, "THB")).toBe(135.0);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(fromMinorUnits(1500, "JPY")).toBe(1500);
  });
});
