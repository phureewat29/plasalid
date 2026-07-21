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
} from "../../db/queries/account-balance.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "../../db/queries/account-match.js";
import { ensureAccountAncestors } from "../../scanner/resolve.js";
import { fromMinorUnits } from "../../currency.js";
import { applyRedaction } from "../../privacy/redactor.js";
import { parseInput, str, num, int, json } from "../../lib/validate.js";

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

const CREATE_ACCOUNT_SPEC = {
  id: str().required("--id"),
  name: str().required("--name"),
  type: str().required("--type").oneOf(TOP_LEVEL_TYPES),
  parent_id: str().optional().alias("parent"),
  subtype: str().optional(),
  bank_name: str().optional().alias("bank"),
  account_number_masked: str().optional().alias("masked"),
  currency: str().optional(),
  due_day: int().optional(),
  statement_day: int().optional(),
  metadata: json<Record<string, unknown>>().optional(),
};

function createAccountAction(opts: Record<string, unknown>): void {
  const parsed = parseInput(CREATE_ACCOUNT_SPEC, opts);

  const db = getDb();

  // Auto-create missing intermediate ancestors from the id's colon
  // segments when the caller didn't pin an explicit --parent (which is
  // still honored as-is, unchanged). Skipped for an unrecognized type
  // so the usual createAccount validation reports a clean INVALID
  // instead of failing deeper inside the ancestor walk.
  let parentId = parsed.parent_id ?? null;
  let createdParents: string[] = [];
  try {
    if (parsed.parent_id === undefined && TOP_LEVEL_TYPES.includes(parsed.type)) {
      const ancestors = ensureAccountAncestors(db, parsed.id, parsed.type);
      if (ancestors.parentId !== null) {
        parentId = ancestors.parentId;
        createdParents = ancestors.createdParents;
      }
    }

    const input: CreateAccountInput = {
      id: parsed.id,
      name: parsed.name,
      type: parsed.type,
      parent_id: parentId,
      subtype: parsed.subtype ?? null,
      bank_name: parsed.bank_name ?? null,
      account_number_masked: parsed.account_number_masked ?? null,
      currency: parsed.currency,
      due_day: parsed.due_day ?? null,
      statement_day: parsed.statement_day ?? null,
      metadata: parsed.metadata ?? null,
    };
    createAccount(db, input);
    emit({ id: input.id, created: true, created_parents: createdParents });
  } catch (err) {
    mapAccountError(err);
  }
}

const MERGE_ACCOUNTS_SPEC = {
  from: str().required("--from"),
  to: str().required("--to"),
};

function mergeAccountsAction(opts: { from?: string; to?: string; yes?: boolean }): void {
  const parsed = parseInput(MERGE_ACCOUNTS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging accounts");
  const db = getDb();
  let result;
  try {
    result = mergeAccounts(db, parsed.from, parsed.to);
  } catch (err) {
    mapAccountError(err);
  }
  emit({
    from: parsed.from,
    to: parsed.to,
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

const ADJUST_ACCOUNT_SPEC = {
  to: num().required("--to"),
  reason: str().required("--reason"),
  date: str().optional(),
};

function adjustAccountAction(
  id: string,
  opts: { to?: string; reason?: string; date?: string },
): void {
  const parsed = parseInput(ADJUST_ACCOUNT_SPEC, opts as Record<string, unknown>);

  const db = getDb();
  let result;
  try {
    result = adjustAccountBalanceViaTransaction(db, {
      accountId: id,
      targetAmount: parsed.to,
      reason: parsed.reason,
      date: parsed.date,
    });
  } catch (err) {
    mapAccountError(err);
  }
  emit({ transaction_id: result.transactionId, delta: result.delta });
}

const MATCH_ACCOUNTS_SPEC = {
  query: str().required("--query"),
};

function matchAccounts(opts: { query?: string }): void {
  const parsed = parseInput(MATCH_ACCOUNTS_SPEC, opts as Record<string, unknown>);
  const db = getDb();
  const matches = findAccountsByFuzzyName(db, parsed.query);
  emitList(matches, MATCH_COLUMNS);
}

const UPDATE_ACCOUNT_SPEC = {
  name: str().optional(),
  due_day: int().optional().nullable(),
  statement_day: int().optional().nullable(),
  points_balance: int().optional().nullable().alias("points"),
  account_number_masked: str().optional().nullable().alias("masked"),
  bank_name: str().optional().nullable().alias("bank"),
  metadata: json<Record<string, unknown>>().optional(),
};

function updateAccountAction(id: string, opts: Record<string, unknown>): void {
  const parsed = parseInput(UPDATE_ACCOUNT_SPEC, opts, {
    atLeastOne:
      "at least one of --name, --due-day, --statement-day, --points, --masked, --bank, --metadata is required",
  });
  const { name, ...patch } = parsed;

  const db = getDb();
  const result: Record<string, unknown> = { id };

  if (name !== undefined) {
    const changes = renameAccount(db, id, name);
    if (changes === 0) fail("NOT_FOUND", `account "${id}" not found`);
    result.name = name;
    result.renamed = true;
  }

  if (Object.keys(patch).length > 0) {
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
