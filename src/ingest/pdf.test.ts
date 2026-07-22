import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { generateKey } from "../db/encryption.js";
import { config } from "../config.js";
import {
  findCandidates,
  savePassword,
  rasterizePageN,
  unlockNonInteractive,
} from "./pdf.js";

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

describe("rasterizePageN", () => {
  it("renders a given page index to a raw PNG buffer", async () => {
    const png = await rasterizePageN(minimalPdf(), 0, 72);
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.length).toBeGreaterThan(100);
  });
});

async function encryptedPdf(password: string): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(minimalPdf(), "application/pdf");
  try {
    const out = doc.saveToBuffer(
      `encrypt=aes-256,user-password=${password},owner-password=${password}`,
    );
    return Buffer.from(out.asUint8Array());
  } finally {
    doc.destroy();
  }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("unlockNonInteractive", () => {
  beforeEach(() => {
    config.dbEncryptionKey = generateKey();
  });

  it("passes through a non-encrypted PDF unchanged", async () => {
    const db = freshDb();
    const bytes = minimalPdf();
    const result = await unlockNonInteractive(db, bytes, "plain.pdf", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decrypted).toBe(bytes);
  });

  it("unlocks via a matching vault password and records the use", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const id = savePassword(db, "^kbank.*", "secret", config.dbEncryptionKey);

    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {});
    expect(result.ok).toBe(true);

    const row = db
      .prepare(`SELECT use_count FROM file_passwords WHERE id = ?`)
      .get(id) as { use_count: number };
    expect(row.use_count).toBe(1);
  });

  it("persists a caller-supplied password on success", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");

    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    const saved = findCandidates(db, "kbank-may.pdf", config.dbEncryptionKey);
    expect(saved).toHaveLength(1);
    expect(saved[0].password).toBe("secret");
  });

  it("reports wrong_password for a bad caller password", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {
      password: "nope",
    });
    expect(result).toEqual({ ok: false, reason: "wrong_password" });
  });

  it("reports password_required when nothing unlocks it", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {});
    expect(result).toEqual({ ok: false, reason: "password_required" });
  });

  /**
   * suggestPattern() is a private helper of unlockNonInteractive's persist step, exercised
   * here through its observable effect on findCandidates rather than imported directly.
   */
  it("derives a reusable alpha-prefix pattern, matching sibling statements from the same source", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "AcctSt_May26.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    expect(findCandidates(db, "AcctSt_Dec26.pdf", config.dbEncryptionKey)).toHaveLength(1);
    expect(findCandidates(db, "Other_May26.pdf", config.dbEncryptionKey)).toHaveLength(0);
  });

  it("falls back to a digit-collapsed pattern when the prefix is too short or non-alpha", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "1234567890.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    expect(findCandidates(db, "9876543210.pdf", config.dbEncryptionKey)).toHaveLength(1);
    expect(findCandidates(db, "abc.pdf", config.dbEncryptionKey)).toHaveLength(0);
  });
});
