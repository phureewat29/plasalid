import type Database from "libsql";
import { accountHasTransactions } from "../db/queries/transactions.js";
import { normalizeMaskedAccountNumber } from "./matching.js";
import { buildPatch, type PatchField } from "../lib/patch.js";
import { errorMessage } from "../lib/result.js";
import { parseJsonOrNull } from "../lib/json.js";
import { config } from "../config.js";
import {
  type AccountType,
  TOP_LEVEL_TYPES,
  type AccountRow,
  type CreateAccountInput,
  type UpdateAccountMetadataPatch,
} from "./types.js";

const TYPE_ROOT_NAME: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
};

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
}

export function countAccounts(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number };
  return row.n;
}

export function renameAccount(db: Database.Database, id: string, name: string): number {
  return db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id).changes;
}

/** Idempotently insert a top-level type root (id = type name, parent_id = null). */
export function ensureTopLevelRoot(db: Database.Database, type: AccountType): void {
  if (findAccountById(db, type)) return;
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, NULL)`,
  ).run(type, TYPE_ROOT_NAME[type], type);
}

/**
 * Idempotently insert one of the structural accounts the system auto-creates:
 *  - `expense:uncategorized`  (suspense for unclassifiable expense entries)
 *  - `equity:adjustments`     (balancing side of `adjust_account_balance`)
 *  - `equity:opening-balance` (starting state imports)
 * The top-level root is bootstrapped first when missing.
 */
export function ensureStructuralAccount(
  db: Database.Database,
  id: "expense:uncategorized" | "equity:adjustments" | "equity:opening-balance",
): void {
  if (findAccountById(db, id)) return;
  const [type, leaf] = id.split(":") as [AccountType, string];
  ensureTopLevelRoot(db, type);
  const name = leaf === "uncategorized" ? "Uncategorized"
    : leaf === "adjustments" ? "Adjustments"
    : "Opening Balance";
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`,
  ).run(id, name, type, type);
}

/**
 * Enforces the hierarchy invariants: top-level roots have parent_id null and
 * id == type; children need an existing same-type parent (its top-level root
 * auto-bootstraps, intermediate categories don't) and an id prefixed
 * `parent.id + ':'`. Throws on any violation; the caller does the INSERT.
 */
function validateAccountHierarchy(
  db: Database.Database,
  input: CreateAccountInput,
  parentId: string | null,
): void {
  if (parentId === null) {
    if (!TOP_LEVEL_TYPES.includes(input.id as AccountType)) {
      throw new Error(
        `Account "${input.id}" has no parent_id; only top-level type roots may have a null parent (one of ${TOP_LEVEL_TYPES.join(", ")}).`,
      );
    }
    if (input.id !== input.type) {
      throw new Error(`Top-level root id "${input.id}" must equal its type "${input.type}".`);
    }
    return;
  }

  let parent = findAccountById(db, parentId);
  if (!parent && TOP_LEVEL_TYPES.includes(parentId as AccountType)) {
    ensureTopLevelRoot(db, parentId as AccountType);
    parent = findAccountById(db, parentId);
  }
  if (!parent) {
    throw new Error(`Parent account "${parentId}" does not exist; create it first.`);
  }
  if (parent.type !== input.type) {
    throw new Error(
      `Account "${input.id}" type "${input.type}" does not match parent "${parentId}" type "${parent.type}".`,
    );
  }
  if (!input.id.startsWith(parent.id + ":")) {
    throw new Error(`Account id "${input.id}" must start with parent id "${parent.id}:".`);
  }
}

/** Inserts an account after enforcing the hierarchy invariants. A duplicate id
 *  surfaces as an Error with code 'ACCOUNT_EXISTS'. */
export function createAccount(db: Database.Database, input: CreateAccountInput): void {
  const bank = input.bank_name ? String(input.bank_name).toUpperCase() : null;
  const maskedNumber = normalizeMaskedAccountNumber(input.account_number_masked);
  const parentId = input.parent_id ?? null;

  validateAccountHierarchy(db, input, parentId);

  try {
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name, account_number_masked, currency, due_day, statement_day, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.type,
      parentId,
      input.subtype ?? null,
      bank,
      maskedNumber,
      input.currency ?? config.displayCurrency,
      input.due_day ?? null,
      input.statement_day ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("UNIQUE")) {
      const dup = new Error(`Account "${input.id}" already exists.`) as Error & { code?: string };
      dup.code = "ACCOUNT_EXISTS";
      throw dup;
    }
    throw err;
  }
}

interface UpdateAccountMetadataResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const ACCOUNT_PATCH: Record<string, PatchField> = {
  due_day: {},
  statement_day: {},
  points_balance: {},
  account_number_masked: {
    transform: (v) => normalizeMaskedAccountNumber(v as string | null),
  },
  bank_name: {
    transform: (v) => (v == null ? null : String(v).toUpperCase()),
  },
};

/**
 * Returns before/after snapshots of touched fields for a reversible audit
 * record. `metadata` is shallow-merged into the existing metadata_json blob.
 */
export function updateAccountMetadata(
  db: Database.Database,
  id: string,
  patch: UpdateAccountMetadataPatch,
): UpdateAccountMetadataResult {
  const current = findAccountById(db, id);
  if (!current) throw new Error(`Account "${id}" not found.`);

  const { sets, params, before, after } = buildPatch(ACCOUNT_PATCH, current, patch);

  if (patch.metadata !== undefined) {
    // A non-null blob that fails to parse must surface an error, not be
    // silently overwritten with {} — that would discard real (if corrupt) data.
    let existing: Record<string, unknown> = {};
    if (current.metadata_json != null) {
      const parsed = parseJsonOrNull(current.metadata_json);
      if (parsed == null || typeof parsed !== "object") {
        throw new Error(`Account "${id}" has unreadable metadata_json; refusing to overwrite it.`);
      }
      existing = parsed as Record<string, unknown>;
    }
    const merged = { ...existing, ...patch.metadata };
    sets.push("metadata_json = ?");
    params.push(JSON.stringify(merged));
    before.metadata = existing;
    after.metadata = merged;
  }

  if (sets.length === 0) return { before, after };
  params.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { before, after };
}

interface MergeAccountsResult {
  /** Transaction legs re-pointed from the source account onto the destination. */
  moved: number;
  /** Transactions deleted because re-pointing would have collapsed them into a
   *  degenerate self-transaction (debit == credit). */
  deletedSelfTransactions: number;
}

/** Re-points every transaction leg on `fromId` to `toId`, then deletes the
 *  source account. Refuses if the source still has children. */
export function mergeAccounts(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeAccountsResult {
  if (fromId === toId) throw new Error("Cannot merge an account into itself.");
  const from = findAccountById(db, fromId);
  if (!from) throw new Error(`Source account ${fromId} not found.`);
  const to = findAccountById(db, toId);
  if (!to) throw new Error(`Destination account ${toId} not found.`);

  const childCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(fromId) as { n: number };
  if (childCount.n > 0) {
    throw new Error(`Account ${fromId} has ${childCount.n} child account(s); merge or delete them first.`);
  }

  const { moved, deletedSelfTransactions } = repointTransactions(db, fromId, toId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  return { moved, deletedSelfTransactions };
}

/** Delete an account only if no transactions reference it AND it has no children. */
export function deleteAccount(db: Database.Database, id: string): void {
  if (accountHasTransactions(db, id)) {
    throw new Error(`Account ${id} still has transactions; merge it first.`);
  }
  const childCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(id) as { n: number };
  if (childCount.n > 0) {
    throw new Error(`Account ${id} has ${childCount.n} child account(s); delete them first.`);
  }
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
}

/** Recursive CTE walk over `accounts.parent_id`: root plus every descendant. */
export function getAccountSubtree(db: Database.Database, rootId: string): AccountRow[] {
  return db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT * FROM accounts WHERE id = ?
       UNION ALL
       SELECT a.* FROM accounts a JOIN subtree s ON a.parent_id = s.id
     )
     SELECT * FROM subtree ORDER BY id`,
  ).all(rootId) as AccountRow[];
}

/**
 * Re-point step for `mergeAccounts`. Rows that would become a degenerate
 * self-transaction (one side `fromId`, the other already `toId`) are deleted
 * FIRST — the debit<>credit CHECK forbids that state even transiently — then
 * the remainder is re-pointed. Does not touch the accounts table.
 */
export function repointTransactions(
  db: Database.Database,
  fromId: string,
  toId: string,
): { moved: number; deletedSelfTransactions: number } {
  if (fromId === toId) throw new Error("Cannot re-point transactions to the same account.");

  let moved = 0;
  let deletedSelfTransactions = 0;
  const tx = db.transaction((): void => {
    deletedSelfTransactions = db
      .prepare(
        `DELETE FROM transactions
          WHERE (debit_account_id = ? AND credit_account_id = ?)
             OR (credit_account_id = ? AND debit_account_id = ?)`,
      )
      .run(fromId, toId, fromId, toId).changes;

    const d = db
      .prepare(`UPDATE transactions SET debit_account_id = ? WHERE debit_account_id = ?`)
      .run(toId, fromId).changes;
    const c = db
      .prepare(`UPDATE transactions SET credit_account_id = ? WHERE credit_account_id = ?`)
      .run(toId, fromId).changes;
    moved = d + c;
  });
  tx();
  return { moved, deletedSelfTransactions };
}
