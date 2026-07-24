import { describe, it, expect } from "vitest";
import {
  getInstitutions,
  findInstitutions,
  countryFileSchema,
} from "./institutions.js";
import { findCountryDefaults, availableCountries } from "./defaults.js";
import { listDatasets, readDataset } from "./index.js";

describe("institutions dataset", () => {
  it("reads th.json and tags every row with country TH", () => {
    const th = findInstitutions({ country: "TH" });
    expect(th.length).toBeGreaterThan(0);
    expect(th.every((i) => i.country === "TH")).toBe(true);
  });

  it("exposes known TH institutions with their labels", () => {
    const byCode = new Map(findInstitutions({ country: "TH" }).map((i) => [i.code, i]));
    expect(byCode.get("KBANK")).toMatchObject({ label: "Kasikornbank", kind: "bank", country: "TH" });
    expect(byCode.get("BITKUB")).toMatchObject({ kind: "crypto_exchange", country: "TH" });
    expect(byCode.get("PROMPTPAY")).toMatchObject({ kind: "payment_rail" });
  });

  it("loads more than one country", () => {
    const countries = new Set(getInstitutions().map((i) => i.country));
    expect(countries.has("TH")).toBe(true);
    expect(countries.size).toBeGreaterThan(1);
    // A US institution is present and correctly tagged.
    expect(findInstitutions({ country: "US" }).some((i) => i.code === "CHASE")).toBe(true);
  });

  it("matches country case-insensitively", () => {
    expect(findInstitutions({ country: "th" }).length).toBe(
      findInstitutions({ country: "TH" }).length,
    );
  });

  it("filters by kind", () => {
    const banks = findInstitutions({ country: "TH", kind: "bank" });
    expect(banks.length).toBeGreaterThan(0);
    expect(banks.every((i) => i.kind === "bank")).toBe(true);
    expect(banks.map((i) => i.code)).toContain("KBANK");
    expect(banks.map((i) => i.code)).not.toContain("BITKUB");
  });

  it("filters by country and kind together", () => {
    const wallets = findInstitutions({ country: "TH", kind: "wallet" });
    expect(wallets.every((i) => i.country === "TH" && i.kind === "wallet")).toBe(true);
    expect(wallets.map((i) => i.code)).toContain("TRUEMONEY");
  });

  it("returns a stable sort (country then code)", () => {
    const rows = getInstitutions();
    const sorted = [...rows].sort(
      (a, b) => a.country.localeCompare(b.country) || a.code.localeCompare(b.code),
    );
    expect(rows).toEqual(sorted);
  });

  it("getInstitutions hands back a copy, so callers can't corrupt the cache", () => {
    const first = getInstitutions();
    first.length = 0;
    expect(getInstitutions().length).toBeGreaterThan(0);
  });

  it("accepts a well-formed country file", () => {
    const parsed = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", label: "Acme Bank", kind: "bank" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const parsed = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", label: "Acme", kind: "not_a_kind" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an institution missing a required field", () => {
    const parsed = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", kind: "bank" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("defaults dataset", () => {
  it("returns locale + currency for a known country (case-insensitive)", () => {
    expect(findCountryDefaults("th")).toEqual({ country: "TH", locale: "th-TH", currency: "THB" });
    expect(findCountryDefaults("JP")).toEqual({ country: "JP", locale: "ja-JP", currency: "JPY" });
  });

  it("returns null for an unknown country", () => {
    expect(findCountryDefaults("zz")).toBeNull();
  });

  it("lists the available countries (uppercased, sorted)", () => {
    expect(availableCountries()).toEqual(["CN", "JP", "TH", "US"]);
  });
});

describe("generic dataset surface", () => {
  it("listDatasets summarizes each dataset with its countries and row count", () => {
    const summaries = listDatasets();
    const byName = new Map(summaries.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(["defaults", "institutions"]);

    const institutions = byName.get("institutions")!;
    expect(institutions.countries).toContain("TH");
    expect(institutions.rows).toBe(findInstitutions().length);

    const defaults = byName.get("defaults")!;
    expect(defaults.countries).toEqual(["CN", "JP", "TH", "US"]);
    expect(defaults.rows).toBe(4);
  });

  it("readDataset returns country-tagged rows and honors the country filter", () => {
    const th = readDataset("institutions", { country: "th" });
    expect(th.length).toBeGreaterThan(0);
    expect(th.every((r) => r.country === "TH")).toBe(true);

    const defaults = readDataset("defaults", { country: "us" });
    expect(defaults).toEqual([{ country: "US", locale: "en-US", currency: "USD" }]);
  });

  it("readDataset throws on an unknown dataset name", () => {
    expect(() => readDataset("bogus")).toThrow(/unknown dataset/);
  });
});
