import type Database from "libsql";
import { randomUUID, createHash } from "crypto";
import { upsertMerchant, type MerchantUpsertInput } from "./merchants.js";

/**
 * TigerBeetle-style single-row transfer. Replaces the transactions+postings
 * two-table model: every movement of money is one row with an explicit debit
 * account and credit account. `amount` is an INTEGER in the currency's minor
 * units (satang, cents, ...) — decimal <-> minor conversion happens at the
 * CLI/pipeline boundary, never in this layer.
 */
export interface TransferInput {
  /** Optional pre-assigned id. Derived (`tf:` + hash) by the pipeline so
   *  questions recorded mid-scan can reference the transfer before commit. */
  id?: string;
  /** Links this transfer to its siblings (a salary broken into net + tax +
   *  social-security legs, an FX conversion pair, ...). */
  group_id?: string | null;
  date: string;
  description: string;
  /** Pre-resolved merchant id. Overrides any `merchant` upsert when set. */
  merchant_id?: string | null;
  /** Merchant to upsert when no `merchant_id` is supplied. */
  merchant?: MerchantUpsertInput | null;
  raw_descriptor?: string | null;
  source_file_id?: string | null;
  source_page?: number | null;
  debit_account_id: string;
  credit_account_id: string;
  /** Integer minor units. Positive (enforced by validateTransfer + CHECK). */
  amount: number;
  currency: string;
  code?: string | null;
  user_ref?: string | null;
}

export interface TransferRow {
  id: string;
  group_id: string | null;
  date: string;
  description: string;
  merchant_id: string | null;
  raw_descriptor: string | null;
  source_file_id: string | null;
  source_page: number | null;
  debit_account_id: string;
  credit_account_id: string;
  amount: number;
  currency: string;
  code: string | null;
  user_ref: string | null;
  has_question: number;
  created_at: string;
  // Joined for presentation:
  debit_account_name: string | null;
  credit_account_name: string | null;
  merchant_name: string | null;
}

/** A queried transfer plus every member of its group (self included). */
export interface TransferDetail extends TransferRow {
  group?: TransferRow[];
}

export type ValidateTransferResult = { ok: true } | { ok: false; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Structural invariants for a transfer. Amount must already be an integer in
 * minor units (this layer never sees decimals). Pure; no DB access.
 */
export function validateTransfer(input: TransferInput): ValidateTransferResult {
  if (!ISO_DATE.test(input.date ?? "")) {
    return { ok: false, reason: "Transfer date must be an ISO date (YYYY-MM-DD)." };
  }
  if (!input.description || !input.description.trim()) {
    return { ok: false, reason: "Transfer description must not be empty." };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: "Transfer amount must be a positive integer in minor units." };
  }
  if (!input.debit_account_id || !input.debit_account_id.trim()) {
    return { ok: false, reason: "Transfer debit_account_id must not be empty." };
  }
  if (!input.credit_account_id || !input.credit_account_id.trim()) {
    return { ok: false, reason: "Transfer credit_account_id must not be empty." };
  }
  if (input.debit_account_id === input.credit_account_id) {
    return { ok: false, reason: "Transfer debit and credit accounts must differ." };
  }
  return { ok: true };
}

/**
 * Deterministic transfer id from the source coordinates so re-scanning the same
 * file is idempotent: `tf:` + first 16 hex of sha256("<hash>|<page>|<row>" plus
 * "|<leg>" when a leg index is supplied). Legged linked transfers therefore get
 * distinct ids while the non-legged form shares its hash with `deriveGroupId`.
 */
export function deriveTransferId(
  fileHash: string,
  page: number,
  rowIndex: number,
  legIndex?: number,
): string {
  const base = `${fileHash}|${page}|${rowIndex}`;
  const material = legIndex != null ? `${base}|${legIndex}` : base;
  return "tf:" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Deterministic group id for a source row: `tg:` + same hash as the legless
 *  `deriveTransferId(fileHash, page, rowIndex)`. */
export function deriveGroupId(fileHash: string, page: number, rowIndex: number): string {
  return "tg:" + createHash("sha256").update(`${fileHash}|${page}|${rowIndex}`).digest("hex").slice(0, 16);
}

const INSERT_COLUMNS =
  "id, group_id, date, description, merchant_id, raw_descriptor, source_file_id, source_page, debit_account_id, credit_account_id, amount, currency, code, user_ref";

function insertParams(id: string, merchantId: string | null, input: TransferInput): any[] {
  return [
    id,
    input.group_id ?? null,
    input.date,
    input.description,
    merchantId,
    input.raw_descriptor ?? null,
    input.source_file_id ?? null,
    input.source_page ?? null,
    input.debit_account_id,
    input.credit_account_id,
    input.amount,
    input.currency,
    input.code ?? null,
    input.user_ref ?? null,
  ];
}

/**
 * Idempotent single-transfer insert. Validates first (throws on failure), then
 * `INSERT ... ON CONFLICT(id) DO NOTHING`, so re-inserting the same derived id
 * is a no-op. `duplicate` is true when the row already existed.
 */
export function insertTransfer(
  db: Database.Database,
  input: TransferInput,
): { id: string; duplicate: boolean } {
  const check = validateTransfer(input);
  if (!check.ok) throw new Error(check.reason);

  const id = input.id ?? `tf:${randomUUID()}`;
  let merchantId = input.merchant_id ?? null;
  if (!merchantId && input.merchant) {
    merchantId = upsertMerchant(db, input.merchant).id;
  }

  const result = db
    .prepare(
      `INSERT INTO transfers (${INSERT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(...insertParams(id, merchantId, input));
  return { id, duplicate: result.changes === 0 };
}

export interface InsertLinkedTransfersResult {
  results: { id: string; duplicate: boolean }[];
  group_id: string;
}

/**
 * Insert several transfers that share one group_id, atomically. A validation or
 * SQL failure on any leg rolls back every leg. The shared group_id is taken
 * from `opts.group_id`, else the first input carrying one, else a fresh `tg:`.
 */
export function insertLinkedTransfers(
  db: Database.Database,
  inputs: TransferInput[],
  opts: { group_id?: string } = {},
): InsertLinkedTransfersResult {
  if (inputs.length === 0) {
    throw new Error("insertLinkedTransfers requires at least one transfer.");
  }
  const groupId =
    opts.group_id ?? inputs.find((i) => i.group_id)?.group_id ?? `tg:${randomUUID()}`;

  let results: { id: string; duplicate: boolean }[] = [];
  const tx = db.transaction((): void => {
    results = inputs.map((input) => insertTransfer(db, { ...input, group_id: groupId }));
  });
  tx();
  return { results, group_id: groupId };
}

const ROW_SELECT = `SELECT t.id, t.group_id, t.date, t.description, t.merchant_id,
        t.raw_descriptor, t.source_file_id, t.source_page,
        t.debit_account_id, t.credit_account_id, t.amount, t.currency,
        t.code, t.user_ref, t.has_question, t.created_at,
        da.name AS debit_account_name,
        ca.name AS credit_account_name,
        m.canonical_name AS merchant_name
   FROM transfers t
   LEFT JOIN accounts da ON da.id = t.debit_account_id
   LEFT JOIN accounts ca ON ca.id = t.credit_account_id
   LEFT JOIN merchants m ON m.id = t.merchant_id`;

/**
 * Load a single transfer (joined to account + merchant names). When the row
 * belongs to a group, `group` carries every member of that group (self
 * included), ordered by id. Returns null when the id doesn't exist.
 */
export function getTransfer(db: Database.Database, id: string): TransferDetail | null {
  const row = db.prepare(`${ROW_SELECT} WHERE t.id = ?`).get(id) as TransferRow | undefined;
  if (!row) return null;
  if (!row.group_id) return row;
  const group = db
    .prepare(`${ROW_SELECT} WHERE t.group_id = ? ORDER BY t.id`)
    .all(row.group_id) as TransferRow[];
  return { ...row, group };
}

export interface ListTransfersOptions {
  /** Match either side (debit OR credit) of the transfer. */
  account?: string;
  from?: string;
  to?: string;
  /** LIKE over description, raw_descriptor, merchant name, either account name. */
  query?: string;
  limit?: number;
  /** When true, fold rows into per-group_id clusters (NULLs stay standalone). */
  group?: boolean;
}

export interface TransferCluster {
  group_id: string | null;
  transfers: TransferRow[];
}

export function listTransfers(
  db: Database.Database,
  opts: ListTransfersOptions & { group: true },
): TransferCluster[];
export function listTransfers(
  db: Database.Database,
  opts?: ListTransfersOptions & { group?: false },
): TransferRow[];
export function listTransfers(
  db: Database.Database,
  opts: ListTransfersOptions = {},
): TransferRow[] | TransferCluster[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.account) {
    conditions.push("(t.debit_account_id = ? OR t.credit_account_id = ?)");
    params.push(opts.account, opts.account);
  }
  if (opts.from) {
    conditions.push("t.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push("t.date <= ?");
    params.push(opts.to);
  }
  if (opts.query) {
    conditions.push(
      "(t.description LIKE ? OR t.raw_descriptor LIKE ? OR m.canonical_name LIKE ? OR da.name LIKE ? OR ca.name LIKE ?)",
    );
    const like = `%${opts.query}%`;
    params.push(like, like, like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  const rows = db
    .prepare(`${ROW_SELECT} ${where} ORDER BY t.date DESC, t.id DESC LIMIT ?`)
    .all(...params, limit) as TransferRow[];

  return opts.group ? clusterByGroup(rows) : rows;
}

/**
 * Fold rows into per-group clusters, preserving the incoming (date DESC, id
 * DESC) order for cluster first-appearance. Rows with a null group_id each
 * become their own standalone cluster.
 */
function clusterByGroup(rows: TransferRow[]): TransferCluster[] {
  const clusters: TransferCluster[] = [];
  const byGroup = new Map<string, TransferCluster>();
  for (const row of rows) {
    if (row.group_id == null) {
      clusters.push({ group_id: null, transfers: [row] });
      continue;
    }
    let cluster = byGroup.get(row.group_id);
    if (!cluster) {
      cluster = { group_id: row.group_id, transfers: [] };
      byGroup.set(row.group_id, cluster);
      clusters.push(cluster);
    }
    cluster.transfers.push(row);
  }
  return clusters;
}

export function deleteTransfer(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM transfers WHERE id = ?`).run(id).changes > 0;
}

export interface BulkRecategorizeFilter {
  /** Required. Recategorize transfers touching this account (either side). */
  accountId: string;
  descriptionContains?: string;
  merchantId?: string;
  currency?: string;
  from?: string;
  to?: string;
}

export interface BulkRecategorizeSet {
  accountId: string;
}

export interface BulkRecategorizeResult {
  affected: number;
  /** Rows skipped because moving them would make debit == credit. */
  skipped_self_transfer: number;
  sample_transfer_ids: string[];
}

/**
 * Re-point every matching transfer's `:from` side (debit OR credit) to `:to`
 * via a dual-column CASE update. Rows whose OTHER side already equals `:to` are
 * skipped (moving them would violate the debit<>credit CHECK) and counted in
 * `skipped_self_transfer`. Verifies `:to` exists and refuses the no-op where
 * `:to == :from`. `filter.accountId` is required — there is no
 * "recategorize everything" escape hatch.
 */
export function bulkRecategorize(
  db: Database.Database,
  filter: BulkRecategorizeFilter,
  set: BulkRecategorizeSet,
): BulkRecategorizeResult {
  const from = filter.accountId;
  const to = set.accountId;
  if (!from) throw new Error("bulkRecategorize: filter.accountId is required.");
  if (!to) throw new Error("bulkRecategorize: set.accountId is required.");
  if (from === to) {
    throw new Error("bulkRecategorize: set.accountId equals filter.accountId (no-op).");
  }
  if (!accountExists(db, to)) {
    throw new Error(`bulkRecategorize: target account "${to}" does not exist.`);
  }

  const where: string[] = ["(t.debit_account_id = ? OR t.credit_account_id = ?)"];
  const params: any[] = [from, from];
  if (filter.currency)   { where.push("t.currency = ?");    params.push(filter.currency); }
  if (filter.merchantId) { where.push("t.merchant_id = ?"); params.push(filter.merchantId); }
  if (filter.from)       { where.push("t.date >= ?");       params.push(filter.from); }
  if (filter.to)         { where.push("t.date <= ?");       params.push(filter.to); }
  if (filter.descriptionContains) {
    where.push("LOWER(t.description) LIKE ?");
    params.push(`%${filter.descriptionContains.toLowerCase()}%`);
  }
  const whereSql = where.join(" AND ");

  let affected = 0;
  let skipped = 0;
  let sample: string[] = [];
  const tx = db.transaction((): void => {
    const rows = db
      .prepare(
        `SELECT t.id, t.debit_account_id, t.credit_account_id FROM transfers t WHERE ${whereSql}`,
      )
      .all(...params) as { id: string; debit_account_id: string; credit_account_id: string }[];

    const toUpdate: string[] = [];
    for (const r of rows) {
      const other = r.debit_account_id === from ? r.credit_account_id : r.debit_account_id;
      if (other === to) {
        skipped++;
        continue;
      }
      toUpdate.push(r.id);
    }
    if (toUpdate.length === 0) return;

    sample = toUpdate.slice(0, 10);
    const placeholders = toUpdate.map(() => "?").join(",");
    affected = db
      .prepare(
        `UPDATE transfers
           SET debit_account_id  = CASE WHEN debit_account_id  = ? THEN ? ELSE debit_account_id  END,
               credit_account_id = CASE WHEN credit_account_id = ? THEN ? ELSE credit_account_id END
         WHERE id IN (${placeholders})`,
      )
      .run(from, to, from, to, ...toUpdate).changes;
  });
  tx();
  return { affected, skipped_self_transfer: skipped, sample_transfer_ids: sample };
}

export interface DuplicateTransferRow {
  id: string;
  group_id: string | null;
  date: string;
  description: string;
  amount: number;
  currency: string;
  source_file_id: string | null;
  merchant_id: string | null;
  debit_account_id: string;
  credit_account_id: string;
  debit_account_name: string | null;
  credit_account_name: string | null;
}

export interface FindDuplicateTransfersOptions {
  /** Day slack when grouping by date. 0 = same-day only. Default 2. */
  toleranceDays?: number;
  /** Only consider transfers touching this account (either side). */
  accountId?: string;
  /** Skip transfers below this amount (minor units). */
  minAmount?: number;
}

/**
 * Group candidate duplicates: same amount AND same directional account pair,
 * within `toleranceDays`. Transfers sharing a non-null group_id never match
 * each other (a salary split into legs is not a set of duplicates). Returns
 * connected components of size >= 2.
 */
export function findDuplicateTransfers(
  db: Database.Database,
  opts: FindDuplicateTransfersOptions = {},
): DuplicateTransferRow[][] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 2));
  const minAmount = opts.minAmount ?? 0;

  const params: any[] = [];
  let where = "";
  if (opts.accountId) {
    where = "WHERE (t.debit_account_id = ? OR t.credit_account_id = ?)";
    params.push(opts.accountId, opts.accountId);
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.group_id, t.date, t.description, t.amount, t.currency,
              t.source_file_id, t.merchant_id, t.debit_account_id, t.credit_account_id,
              da.name AS debit_account_name, ca.name AS credit_account_name
         FROM transfers t
         LEFT JOIN accounts da ON da.id = t.debit_account_id
         LEFT JOIN accounts ca ON ca.id = t.credit_account_id
         ${where}`,
    )
    .all(...params) as DuplicateTransferRow[];

  const buckets = new Map<string, DuplicateTransferRow[]>();
  for (const r of rows) {
    if (r.amount < minAmount) continue;
    const key = `${r.amount}|${r.debit_account_id}|${r.credit_account_id}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const groups: DuplicateTransferRow[][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (const comp of proximityComponents(bucket, toleranceDays)) {
      if (comp.length >= 2) groups.push(comp);
    }
  }
  return groups;
}

/**
 * Union rows within a same-amount/same-pair bucket: two rows link when their
 * dates are within tolerance AND they don't share a non-null group_id. Returns
 * the connected components.
 */
function proximityComponents(
  bucket: DuplicateTransferRow[],
  toleranceDays: number,
): DuplicateTransferRow[][] {
  const n = bucket.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bucket[i];
      const b = bucket[j];
      if (dayDiff(a.date, b.date) > toleranceDays) continue;
      if (a.group_id && b.group_id && a.group_id === b.group_id) continue;
      union(i, j);
    }
  }

  const comps = new Map<number, DuplicateTransferRow[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = comps.get(root) ?? [];
    arr.push(bucket[i]);
    comps.set(root, arr);
  }
  return [...comps.values()];
}

export interface CorrelatedTransferPeer {
  id: string;
  date: string;
  description: string;
  debit_account_id: string;
  credit_account_id: string;
  debit_account_name: string | null;
  credit_account_name: string | null;
}

export interface CorrelatedTransferPair {
  amount: number;
  currency: string;
  day_gap: number;
  a: CorrelatedTransferPeer;
  b: CorrelatedTransferPeer;
}

export interface FindCorrelatedTransfersOptions {
  from?: string;
  to?: string;
  /** Max day gap between paired transfers. Default 3. */
  toleranceDays?: number;
  /** Skip transfers below this amount (minor units). Default 0. */
  minAmount?: number;
}

/**
 * Internal-transfer detector: surface pairs of same amount + currency whose
 * account pairs are DISJOINT (share no account), within `toleranceDays` — the
 * classic "one money movement landed on two different statements" pattern.
 * Overlapping pairs are duplicates, not correlations, and are skipped.
 */
export function findCorrelatedTransfers(
  db: Database.Database,
  opts: FindCorrelatedTransfersOptions = {},
): CorrelatedTransferPair[] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 3));
  const minAmount = opts.minAmount ?? 0;

  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.from) { conditions.push("t.date >= ?"); params.push(opts.from); }
  if (opts.to)   { conditions.push("t.date <= ?"); params.push(opts.to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.description, t.amount, t.currency,
              t.debit_account_id, t.credit_account_id,
              da.name AS debit_account_name, ca.name AS credit_account_name
         FROM transfers t
         LEFT JOIN accounts da ON da.id = t.debit_account_id
         LEFT JOIN accounts ca ON ca.id = t.credit_account_id
         ${where}`,
    )
    .all(...params) as (CorrelatedTransferPeer & { amount: number; currency: string })[];

  const buckets = new Map<string, (CorrelatedTransferPeer & { amount: number; currency: string })[]>();
  for (const r of rows) {
    if (r.amount < minAmount) continue;
    const key = `${r.amount}|${r.currency}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const pairs: CorrelatedTransferPair[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((x, y) => x.date.localeCompare(y.date));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        const gap = dayDiff(a.date, b.date);
        if (gap > toleranceDays) break;
        const aSet = new Set([a.debit_account_id, a.credit_account_id]);
        if (aSet.has(b.debit_account_id) || aSet.has(b.credit_account_id)) continue;
        pairs.push({ amount: a.amount, currency: a.currency, day_gap: gap, a: peer(a), b: peer(b) });
      }
    }
  }
  return pairs;
}

function peer(r: CorrelatedTransferPeer): CorrelatedTransferPeer {
  return {
    id: r.id,
    date: r.date,
    description: r.description,
    debit_account_id: r.debit_account_id,
    credit_account_id: r.credit_account_id,
    debit_account_name: r.debit_account_name,
    credit_account_name: r.credit_account_name,
  };
}

export function countTransfers(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM transfers`).get() as { n: number }).n;
}

export function countTransfersBySourceFile(db: Database.Database, fileId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM transfers WHERE source_file_id = ?`).get(fileId) as {
      n: number;
    }
  ).n;
}

/** True when any transfer references `accountId` on either its debit or credit
 *  side. Used as the "account still in use" guard before deleting an account. */
export function accountHasTransfers(db: Database.Database, accountId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM transfers WHERE debit_account_id = ? OR credit_account_id = ? LIMIT 1`,
    )
    .get(accountId, accountId);
}

export interface UpdateTransferMetaFields {
  date?: string;
  description?: string;
  merchant_id?: string | null;
  source_page?: number | null;
}

/**
 * Edit a transfer's mutable metadata. Amount, currency, and the account columns
 * are intentionally NOT accepted here — moving accounts is `bulkRecategorize`'s
 * job, and amount/currency edits must go through delete + re-record to keep the
 * minor-unit invariants intact. Returns the number of rows changed.
 */
export function updateTransferMeta(
  db: Database.Database,
  id: string,
  fields: UpdateTransferMetaFields,
): number {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.date !== undefined)        { sets.push("date = ?");        params.push(fields.date); }
  if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
  if (fields.merchant_id !== undefined) { sets.push("merchant_id = ?"); params.push(fields.merchant_id); }
  if (fields.source_page !== undefined) { sets.push("source_page = ?"); params.push(fields.source_page); }
  if (sets.length === 0) return 0;
  params.push(id);
  return db.prepare(`UPDATE transfers SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

function accountExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM accounts WHERE id = ? LIMIT 1`).get(id);
}

/** Whole-day distance between two ISO dates; +Infinity on unparseable input. */
export function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}
