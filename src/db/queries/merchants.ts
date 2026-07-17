import type Database from "libsql";
import { randomUUID } from "crypto";

export interface MerchantUpsertInput {
  canonical_name: string;
  alias?: string;
  default_account_id?: string | null;
}

export interface MerchantRow {
  id: string;
  canonical_name: string;
  default_account_id: string | null;
  created_at: string;
}

/**
 * Strip the noise that PDF descriptors carry on top of a merchant identity:
 * trailing store ids, terminal codes, city tags, transaction-type words. The
 * normalized form is what `merchant_aliases.normalized_pattern` indexes, so
 * "STARBUCKS #1234 BKK CHARGE" and "Starbucks #5678 BANGKOK" collapse to the
 * same alias "starbucks".
 */
const NOISE_TOKENS = new Set([
  "bkk", "bangkok", "thailand", "th", "tha",
  "charge", "purchase", "payment", "pmt", "ref", "txn", "trx", "tx",
  "pos", "atm", "online", "web", "mobile", "app",
  "co", "ltd", "company", "inc", "llc", "plc", "intl",
]);

export function normalizeDescriptor(raw: string): string {
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  const stripped = lowered
    .replace(/[#*][a-z0-9]+/gi, " ")
    .replace(/\b\d{2,}\b/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter(t => t.length > 1 && !NOISE_TOKENS.has(t));
  if (tokens.length === 0) return stripped;
  return tokens.join(" ");
}

/**
 * Upsert a merchant by canonical_name. Optionally upsert an alias and update
 * the cached default_account_id. Idempotent: re-running with the same inputs
 * does not duplicate rows. Designed to be called inside the same DB transaction
 * as the posting writes so a transaction never lands without its merchant.
 */
export function upsertMerchant(
  db: Database.Database,
  input: MerchantUpsertInput,
): MerchantRow {
  const canonical = input.canonical_name.trim();
  if (!canonical) {
    throw new Error("merchant canonical_name is required");
  }

  const existing = db
    .prepare(`SELECT id, canonical_name, default_account_id, created_at FROM merchants WHERE canonical_name = ?`)
    .get(canonical) as MerchantRow | undefined;

  let merchant: MerchantRow;
  if (existing) {
    merchant = existing;
    if (input.default_account_id && input.default_account_id !== existing.default_account_id) {
      db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
        .run(input.default_account_id, existing.id);
      merchant = { ...existing, default_account_id: input.default_account_id };
    }
  } else {
    const id = `m:${randomUUID()}`;
    db.prepare(
      `INSERT INTO merchants (id, canonical_name, default_account_id) VALUES (?, ?, ?)`,
    ).run(id, canonical, input.default_account_id ?? null);
    merchant = {
      id,
      canonical_name: canonical,
      default_account_id: input.default_account_id ?? null,
      created_at: new Date().toISOString(),
    };
  }

  if (input.alias) {
    const normalized = normalizeDescriptor(input.alias);
    if (normalized) {
      const existsAlias = db
        .prepare(`SELECT id FROM merchant_aliases WHERE normalized_pattern = ?`)
        .get(normalized) as { id: string } | undefined;
      if (!existsAlias) {
        db.prepare(
          `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`,
        ).run(`ma:${randomUUID()}`, merchant.id, normalized);
      }
    }
  }

  return merchant;
}

interface MerchantWithDefault {
  merchant: MerchantRow;
  default_account_id: string | null;
}

/**
 * Resolve a raw PDF descriptor to a known merchant via the alias table.
 * Returns null if no alias matches. The scanner uses this in its pre-resolution
 * pass so the LLM can skip re-categorizing already-seen merchants.
 */
export function findMerchantByAlias(
  db: Database.Database,
  rawDescriptor: string,
): MerchantWithDefault | null {
  const normalized = normalizeDescriptor(rawDescriptor);
  if (!normalized) return null;

  const row = db.prepare(
    `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at
     FROM merchant_aliases ma
     JOIN merchants m ON m.id = ma.merchant_id
     WHERE ma.normalized_pattern = ?`,
  ).get(normalized) as MerchantRow | undefined;

  if (!row) return null;
  return { merchant: row, default_account_id: row.default_account_id };
}

interface ListMerchantsOptions {
  limit?: number;
}

export function listMerchants(
  db: Database.Database,
  opts: ListMerchantsOptions = {},
): (MerchantRow & { alias_count: number })[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  return db.prepare(
    `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at,
            (SELECT COUNT(*) FROM merchant_aliases ma WHERE ma.merchant_id = m.id) AS alias_count
     FROM merchants m
     ORDER BY m.canonical_name
     LIMIT ?`,
  ).all(limit) as (MerchantRow & { alias_count: number })[];
}

export function findMerchantById(
  db: Database.Database,
  id: string,
): MerchantRow | null {
  const row = db
    .prepare(`SELECT id, canonical_name, default_account_id, created_at FROM merchants WHERE id = ?`)
    .get(id) as MerchantRow | undefined;
  return row ?? null;
}

export function setMerchantDefaultAccount(
  db: Database.Database,
  merchantId: string,
  accountId: string,
): { before: string | null; after: string } {
  const before = db
    .prepare(`SELECT default_account_id FROM merchants WHERE id = ?`)
    .get(merchantId) as { default_account_id: string | null } | undefined;
  if (!before) throw new Error(`merchant not found: ${merchantId}`);
  db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
    .run(accountId, merchantId);
  return { before: before.default_account_id, after: accountId };
}

export function clearMerchantDefaultAccount(
  db: Database.Database,
  merchantId: string,
): { before: string | null } | null {
  const row = db
    .prepare(`SELECT default_account_id FROM merchants WHERE id = ?`)
    .get(merchantId) as { default_account_id: string | null } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE merchants SET default_account_id = NULL WHERE id = ?`).run(merchantId);
  return { before: row.default_account_id };
}
