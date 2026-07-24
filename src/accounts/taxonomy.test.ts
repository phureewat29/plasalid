import { describe, it, expect } from "vitest";
import {
  getInstitutions,
  findInstitutions,
  countryFileSchema,
} from "./taxonomy.js";

describe("taxonomy loader", () => {
  it("reads th.json and tags every row with country TH", () => {
    const th = findInstitutions({ country: "TH" });
    expect(th.length).toBeGreaterThan(0);
    expect(th.every((i) => i.country === "TH")).toBe(true);
  });

  it("exposes known TH institutions with their labels", () => {
    const byCode = new Map(getInstitutions().map((i) => [i.code, i]));
    expect(byCode.get("KBANK")).toMatchObject({ label: "Kasikornbank", kind: "bank", country: "TH" });
    expect(byCode.get("BITKUB")).toMatchObject({ kind: "crypto_exchange", country: "TH" });
    expect(byCode.get("PROMPTPAY")).toMatchObject({ kind: "payment_rail" });
  });

  it("matches country case-insensitively", () => {
    expect(findInstitutions({ country: "th" }).length).toBe(
      findInstitutions({ country: "TH" }).length,
    );
  });

  it("filters by kind", () => {
    const banks = findInstitutions({ kind: "bank" });
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
