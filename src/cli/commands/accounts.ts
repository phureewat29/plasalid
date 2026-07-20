import type { Command } from "commander";
import { getDb } from "../../db/connection.js";
import { currentMode, emit, emitList, fail, requireYes, runAction, type Column } from "../output.js";
import {
  getAccountBalancesFromTransactions,
  getRollupBalanceFromTransactions,
  createAccount,
  renameAccount,
  mergeAccounts,
  deleteAccount,
  adjustAccountBalanceViaTransaction,
  updateAccountMetadata,
  findAccountById,
  TOP_LEVEL_TYPES,
  type AccountType,
  type AccountBalanceMinor,
  type CreateAccountInput,
  type UpdateAccountMetadataPatch,
} from "../../db/queries/account-balance.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "../../db/queries/account-match.js";
import { ensureAccountAncestors } from "../../scanner/resolve.js";
import { fromMinorUnits } from "../../currency.js";
import { applyRedaction } from "../../privacy/redactor.js";

// The account display `name` is the only free-text field; id/parent_id/type/
// currency and the numeric balances are structured data left verbatim.
const ACCOUNT_REDACT_FIELDS = ["name"] as const;

/** An account balance with its minor-unit sums presented as decimals (the CLI
 *  boundary), and the internal `balance_minor` dropped. */
type PresentedAccount = Omit<
  AccountBalanceMinor,
  "balance_minor" | "debits_posted" | "credits_posted"
> & { debits_posted: number; credits_posted: number };

function present(a: AccountBalanceMinor): PresentedAccount {
  const { balance_minor: _bm, debits_posted, credits_posted, ...rest } = a;
  return {
    ...rest,
    debits_posted: fromMinorUnits(debits_posted, a.currency),
    credits_posted: fromMinorUnits(credits_posted, a.currency),
  };
}

/** Thrown-Error → exit code mapping shared by create/merge/delete/adjust/update:
 *  messages that name a missing id ("not found" / "does not exist") map to NOT_FOUND,
 *  everything else (hierarchy mismatches, self-merge, non-empty accounts, duplicates)
 *  is a constraint violation and maps to INVALID. */
function mapAccountError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found|does not exist/i.test(message)) fail("NOT_FOUND", message);
  fail("INVALID", message);
}

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail("USAGE", `${flag} must be a number, got "${value}"`);
  return n;
}

const ACCOUNT_COLUMNS: Column<PresentedAccount>[] = [
  { header: "ID", value: (a) => a.id },
  { header: "Name", value: (a) => a.name },
  { header: "Type", value: (a) => a.type },
  { header: "Parent", value: (a) => a.parent_id ?? "" },
  { header: "Balance", value: (a) => a.balance.toFixed(2), align: "right" },
  { header: "Debits", value: (a) => a.debits_posted.toFixed(2), align: "right" },
  { header: "Credits", value: (a) => a.credits_posted.toFixed(2), align: "right" },
  { header: "Currency", value: (a) => a.currency },
];

const MATCH_COLUMNS: Column<FuzzyAccountMatch>[] = [
  { header: "ID", value: (m) => m.account.id },
  { header: "Name", value: (m) => m.account.name },
  { header: "Type", value: (m) => m.account.type },
  { header: "Similarity", value: (m) => m.similarity.toFixed(3), align: "right" },
];

interface AccountTreeNode {
  id: string;
  name: string;
  type: string;
  balance: number;
  rollup: number;
  children: AccountTreeNode[];
}

function buildAccountTree(
  db: ReturnType<typeof getDb>,
  type: AccountType | undefined,
): AccountTreeNode[] {
  const rows = getAccountBalancesFromTransactions(db, type ? { type } : {});
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenMap = new Map<string, AccountBalanceMinor[]>();
  const roots: AccountBalanceMinor[] = [];
  for (const r of rows) {
    if (r.parent_id && byId.has(r.parent_id)) {
      const arr = childrenMap.get(r.parent_id) ?? [];
      arr.push(r);
      childrenMap.set(r.parent_id, arr);
    } else {
      roots.push(r);
    }
  }
  const build = (row: AccountBalanceMinor): AccountTreeNode => ({
    id: row.id,
    name: row.name,
    type: row.type,
    balance: row.balance,
    rollup: getRollupBalanceFromTransactions(db, row.id),
    children: (childrenMap.get(row.id) ?? []).map(build),
  });
  return roots.map(build);
}

function renderTreeTty(nodes: AccountTreeNode[], depth = 0): void {
  for (const n of nodes) {
    const indent = "  ".repeat(depth);
    process.stdout.write(
      `${indent}${n.name} (${n.id})  ${n.balance.toFixed(2)} [rollup ${n.rollup.toFixed(2)}]\n`,
    );
    renderTreeTty(n.children, depth + 1);
  }
}

function flattenTree(nodes: AccountTreeNode[], depth: number, out: string[]): void {
  for (const n of nodes) {
    out.push(
      [String(depth), n.id, n.name, n.type, n.balance.toFixed(2), n.rollup.toFixed(2)].join("\t"),
    );
    flattenTree(n.children, depth + 1, out);
  }
}

function renderTreePlain(nodes: AccountTreeNode[]): void {
  const out: string[] = [];
  flattenTree(nodes, 0, out);
  if (out.length) process.stdout.write(out.join("\n") + "\n");
}

// Per-subcommand actions (registered by registerAccounts below).

function listAccounts(opts: { type?: string; redact?: boolean }): void {
  const db = getDb();
  const rows = applyRedaction(
    getAccountBalancesFromTransactions(db, opts.type ? { type: opts.type as AccountType } : {}).map(
      present,
    ),
    !!opts.redact,
    ACCOUNT_REDACT_FIELDS,
  );
  emitList(rows, ACCOUNT_COLUMNS);
}

function treeAccounts(opts: { type?: string }): void {
  const db = getDb();
  const roots = buildAccountTree(db, opts.type as AccountType | undefined);
  const mode = currentMode();
  if (mode.json) {
    emit(roots);
    return;
  }
  if (mode.tty) {
    renderTreeTty(roots);
    return;
  }
  renderTreePlain(roots);
}

function showAccount(id: string): void {
  const db = getDb();
  const account = findAccountById(db, id);
  if (!account) fail("NOT_FOUND", `account "${id}" not found`);
  const balances = getAccountBalancesFromTransactions(db);
  const self = balances.find((b) => b.id === id);
  const children = balances
    .filter((b) => b.parent_id === id)
    .map((b) => ({ id: b.id, name: b.name, type: b.type, balance: b.balance }));
  emit({
    ...account,
    balance: self?.balance ?? 0,
    debits_posted: self ? fromMinorUnits(self.debits_posted, self.currency) : 0,
    credits_posted: self ? fromMinorUnits(self.credits_posted, self.currency) : 0,
    rollup: getRollupBalanceFromTransactions(db, id),
    children,
  });
}

interface CreateAccountOpts {
  id?: string;
  name?: string;
  type?: string;
  parent?: string;
  subtype?: string;
  bank?: string;
  masked?: string;
  currency?: string;
  dueDay?: string;
  statementDay?: string;
  metadata?: string;
}

function createAccountAction(opts: CreateAccountOpts): void {
  const missing: string[] = [];
  if (!opts.id) missing.push("--id");
  if (!opts.name) missing.push("--name");
  if (!opts.type) missing.push("--type");
  if (missing.length) fail("USAGE", `${missing.join(", ")} required`);

  let metadata: Record<string, unknown> | null = null;
  if (opts.metadata !== undefined) {
    try {
      metadata = JSON.parse(opts.metadata);
    } catch (err) {
      fail("USAGE", `--metadata must be valid JSON: ${(err as Error).message}`);
    }
  }
  const dueDay = parseOptionalNumber(opts.dueDay, "--due-day");
  const statementDay = parseOptionalNumber(opts.statementDay, "--statement-day");

  const db = getDb();
  const type = opts.type as AccountType;

  // Auto-create missing intermediate ancestors from the id's colon
  // segments when the caller didn't pin an explicit --parent (which is
  // still honored as-is, unchanged). Skipped for an unrecognized type
  // so the usual createAccount validation reports a clean INVALID
  // instead of failing deeper inside the ancestor walk.
  let parentId = opts.parent ?? null;
  let createdParents: string[] = [];
  try {
    if (opts.parent === undefined && TOP_LEVEL_TYPES.includes(type)) {
      const ancestors = ensureAccountAncestors(db, opts.id!, type);
      if (ancestors.parentId !== null) {
        parentId = ancestors.parentId;
        createdParents = ancestors.createdParents;
      }
    }

    const input: CreateAccountInput = {
      id: opts.id!,
      name: opts.name!,
      type,
      parent_id: parentId,
      subtype: opts.subtype ?? null,
      bank_name: opts.bank ?? null,
      account_number_masked: opts.masked ?? null,
      currency: opts.currency,
      due_day: dueDay ?? null,
      statement_day: statementDay ?? null,
      metadata,
    };
    createAccount(db, input);
    emit({ id: input.id, created: true, created_parents: createdParents });
  } catch (err) {
    mapAccountError(err);
  }
}

function mergeAccountsAction(opts: { from?: string; to?: string; yes?: boolean }): void {
  const missing: string[] = [];
  if (!opts.from) missing.push("--from");
  if (!opts.to) missing.push("--to");
  if (missing.length) fail("USAGE", `${missing.join(", ")} required`);
  requireYes(opts, "merging accounts");
  const db = getDb();
  let result;
  try {
    result = mergeAccounts(db, opts.from!, opts.to!);
  } catch (err) {
    mapAccountError(err);
  }
  emit({
    from: opts.from,
    to: opts.to,
    moved: result.moved,
    deleted_self_transactions: result.deletedSelfTransactions,
  });
}

function deleteAccountAction(id: string, opts: { yes?: boolean }): void {
  const db = getDb();
  if (!findAccountById(db, id)) fail("NOT_FOUND", `account "${id}" not found`);
  requireYes(opts, "deleting this account");
  try {
    deleteAccount(db, id);
  } catch (err) {
    mapAccountError(err);
  }
  emit({ id, deleted: true });
}

function adjustAccountAction(
  id: string,
  opts: { to?: string; reason?: string; date?: string },
): void {
  const missing: string[] = [];
  if (opts.to === undefined) missing.push("--to");
  if (!opts.reason) missing.push("--reason");
  if (missing.length) fail("USAGE", `${missing.join(", ")} required`);
  const target = Number(opts.to);
  if (!Number.isFinite(target)) fail("USAGE", `--to must be a number, got "${opts.to}"`);

  const db = getDb();
  let result;
  try {
    result = adjustAccountBalanceViaTransaction(db, {
      accountId: id,
      targetAmount: target,
      reason: opts.reason!,
      date: opts.date,
    });
  } catch (err) {
    mapAccountError(err);
  }
  emit({ transaction_id: result.transactionId, delta: result.delta });
}

function matchAccounts(opts: { query?: string }): void {
  if (!opts.query) fail("USAGE", "--query is required");
  const db = getDb();
  const matches = findAccountsByFuzzyName(db, opts.query);
  emitList(matches, MATCH_COLUMNS);
}

interface UpdateAccountOpts {
  name?: string;
  dueDay?: string;
  statementDay?: string;
  points?: string;
  masked?: string;
  bank?: string;
  metadata?: string;
}

function updateAccountAction(id: string, opts: UpdateAccountOpts): void {
  const patch: UpdateAccountMetadataPatch = {};
  const dueDay = parseOptionalNumber(opts.dueDay, "--due-day");
  if (dueDay !== undefined) patch.due_day = dueDay;
  const statementDay = parseOptionalNumber(opts.statementDay, "--statement-day");
  if (statementDay !== undefined) patch.statement_day = statementDay;
  const points = parseOptionalNumber(opts.points, "--points");
  if (points !== undefined) patch.points_balance = points;
  if (opts.masked !== undefined) patch.account_number_masked = opts.masked;
  if (opts.bank !== undefined) patch.bank_name = opts.bank;
  if (opts.metadata !== undefined) {
    try {
      patch.metadata = JSON.parse(opts.metadata);
    } catch (err) {
      fail("USAGE", `--metadata must be valid JSON: ${(err as Error).message}`);
    }
  }

  const hasName = opts.name !== undefined;
  const hasPatch = Object.keys(patch).length > 0;
  if (!hasName && !hasPatch) {
    fail(
      "USAGE",
      "at least one of --name, --due-day, --statement-day, --points, --masked, --bank, --metadata is required",
    );
  }

  const db = getDb();
  const result: Record<string, unknown> = { id };

  if (hasName) {
    const changes = renameAccount(db, id, opts.name!);
    if (changes === 0) fail("NOT_FOUND", `account "${id}" not found`);
    result.name = opts.name;
    result.renamed = true;
  }

  if (hasPatch) {
    let metaResult;
    try {
      metaResult = updateAccountMetadata(db, id, patch);
    } catch (err) {
      mapAccountError(err);
    }
    Object.assign(result, metaResult);
  }

  emit(result);
}

export function registerAccounts(program: Command): void {
  const accounts = program.command("accounts").description("Manage accounts");

  accounts
    .command("list")
    .description("List accounts")
    .option("--type <type>", "filter by account type")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listAccounts));

  accounts
    .command("tree")
    .description("Show accounts as a tree")
    .option("--type <type>", "filter by account type")
    .action(runAction(treeAccounts));

  accounts
    .command("show <id>")
    .description("Show an account's details")
    .action(runAction(showAccount));

  accounts
    .command("create")
    .description("Create a new account")
    .option("--id <id>", "account id")
    .option("--name <name>", "account name")
    .option("--type <type>", "account type")
    .option("--parent <id>", "parent account id")
    .option("--subtype <s>", "account subtype")
    .option("--bank <name>", "bank name")
    .option("--masked <number>", "masked account number")
    .option("--currency <code>", "currency code")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--metadata <json>", "additional metadata as JSON")
    .action(runAction(createAccountAction));

  accounts
    .command("merge")
    .description("Merge one account into another")
    .option("--from <id>", "account id to merge from")
    .option("--to <id>", "account id to merge into")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeAccountsAction));

  accounts
    .command("delete <id>")
    .description("Delete an account")
    .option("--yes", "skip confirmation")
    .action(runAction(deleteAccountAction));

  accounts
    .command("adjust <id>")
    .description("Adjust an account balance")
    .option("--to <amount>", "target balance amount")
    .option("--reason <text>", "reason for the adjustment")
    .option("--date <date>", "adjustment date")
    .action(runAction(adjustAccountAction));

  accounts
    .command("match")
    .description("Match accounts against a query")
    .option("--query <text>", "search text")
    .action(runAction(matchAccounts));

  accounts
    .command("update <id>")
    .description("Update an account's name and/or metadata")
    .option("--name <name>", "new account name")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--points <n>", "reward points balance")
    .option("--masked <number>", "masked account number")
    .option("--bank <name>", "bank name")
    .option("--metadata <json>", "additional metadata as JSON")
    .action(runAction(updateAccountAction));
}
