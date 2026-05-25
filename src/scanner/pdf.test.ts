import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { generateKey } from "../db/encryption.js";
import {
  suggestPattern,
  findCandidates,
  savePassword,
  rasterizePage,
} from "./pdf.js";

describe("suggestPattern", () => {
  it("takes the leading alpha prefix before the first separator", () => {
    expect(suggestPattern("AcctSt_May26.pdf")).toBe("^acctst.*");
  });

  it("falls back to digit-collapse when the prefix is too short or non-alpha", () => {
    expect(suggestPattern("1234567890.pdf")).toBe("^\\d+\\.pdf$");
  });
});

describe("password store", () => {
  it("round-trips a password through the encrypted column", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const dbKey = generateKey();
    const id = savePassword(db, "^kbank-\\d+\\.pdf$", "hunter2", dbKey);
    const matches = findCandidates(db, "/data/kbank-2026.pdf", dbKey);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(id);
    expect(matches[0].password).toBe("hunter2");
  });
});

function minimalPdf(): Buffer {
  const header = "%PDF-1.4\n";
  const o1 = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
  const o2 = "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n";
  const o3 =
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\n";

  const offset1 = header.length;
  const offset2 = offset1 + o1.length;
  const offset3 = offset2 + o2.length;
  const xrefStart = offset3 + o3.length;

  const xref =
    `xref\n0 4\n` +
    `0000000000 65535 f \n` +
    `${String(offset1).padStart(10, "0")} 00000 n \n` +
    `${String(offset2).padStart(10, "0")} 00000 n \n` +
    `${String(offset3).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + o1 + o2 + o3 + xref + trailer, "latin1");
}

describe("rasterizePage", () => {
  it("renders a one-page PDF to a PNG buffer", async () => {
    const result = await rasterizePage(minimalPdf(), { dpi: 72 });
    expect(result.mime).toBe("image/png");
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(result.bytes.length).toBeGreaterThan(100);
  });
});
