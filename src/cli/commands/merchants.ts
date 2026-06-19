import type { Command } from "commander";
import { getDb } from "../../db/connection.js";
import { emit, emitList, fail, runAction, type Column } from "../output.js";
import {
  listMerchants,
  findMerchantByAlias,
  findMerchantById,
  upsertMerchant,
  setMerchantDefaultAccount,
  clearMerchantDefaultAccount,
  type MerchantRow,
  type MerchantUpsertInput,
} from "../../db/queries/merchants.js";
import { findAccountById } from "../../db/queries/account-balance.js";

const MERCHANT_COLUMNS: Column<MerchantRow & { alias_count: number }>[] = [
  { header: "ID", value: (m) => m.id },
  { header: "Name", value: (m) => m.canonical_name },
  { header: "Default Account", value: (m) => m.default_account_id ?? "" },
  { header: "Aliases", value: (m) => String(m.alias_count), align: "right" },
];

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail("USAGE", `${flag} must be a number, got "${value}"`);
  return n;
}

export function registerMerchants(program: Command): void {
  const merchants = program.command("merchants").description("Manage merchants");

  merchants
    .command("list")
    .description("List merchants")
    .option("--with-default-only", "only show merchants with a default account")
    .option("--limit <n>", "maximum number of results")
    .action(
      runAction((opts: { withDefaultOnly?: boolean; limit?: string }) => {
        const db = getDb();
        const limit = parseOptionalNumber(opts.limit, "--limit");
        const rows = listMerchants(db, { withDefaultOnly: !!opts.withDefaultOnly, limit });
        emitList(rows, MERCHANT_COLUMNS);
      }),
    );

  merchants
    .command("resolve")
    .description("Resolve a merchant from a descriptor")
    .option("--descriptor <text>", "raw transaction descriptor")
    .action(
      runAction((opts: { descriptor?: string }) => {
        if (!opts.descriptor) fail("USAGE", "--descriptor is required");
        const db = getDb();
        const match = findMerchantByAlias(db, opts.descriptor);
        if (!match) {
          emit({ found: false });
          return;
        }
        emit({
          found: true,
          merchant_id: match.merchant.id,
          canonical_name: match.merchant.canonical_name,
          default_account_id: match.default_account_id,
        });
      }),
    );

  merchants
    .command("upsert")
    .description("Create or update a merchant")
    .option("--name <name>", "merchant canonical name")
    .option("--alias <alias>", "merchant alias to add")
    .option("--default-account <id>", "default account id")
    .action(
      runAction((opts: { name?: string; alias?: string; defaultAccount?: string }) => {
        if (!opts.name) fail("USAGE", "--name is required");
        const db = getDb();
        if (opts.defaultAccount && !findAccountById(db, opts.defaultAccount)) {
          fail("NOT_FOUND", `account "${opts.defaultAccount}" not found`);
        }
        const input: MerchantUpsertInput = { canonical_name: opts.name };
        if (opts.alias) input.alias = opts.alias;
        if (opts.defaultAccount) input.default_account_id = opts.defaultAccount;
        const merchant = upsertMerchant(db, input);
        emit(merchant);
      }),
    );

  merchants
    .command("set-default")
    .description("Set a merchant's default account")
    .option("--merchant <id>", "merchant id")
    .option("--account <id>", "account id")
    .action(
      runAction((opts: { merchant?: string; account?: string }) => {
        const missing: string[] = [];
        if (!opts.merchant) missing.push("--merchant");
        if (!opts.account) missing.push("--account");
        if (missing.length) fail("USAGE", `${missing.join(", ")} required`);

        const db = getDb();
        if (!findMerchantById(db, opts.merchant!)) {
          fail("NOT_FOUND", `merchant "${opts.merchant}" not found`);
        }
        if (!findAccountById(db, opts.account!)) {
          fail("NOT_FOUND", `account "${opts.account}" not found`);
        }
        const result = setMerchantDefaultAccount(db, opts.merchant!, opts.account!);
        emit({ merchant_id: opts.merchant, ...result });
      }),
    );

  merchants
    .command("clear-default")
    .description("Clear a merchant's default account")
    .option("--merchant <id>", "merchant id")
    .action(
      runAction((opts: { merchant?: string }) => {
        if (!opts.merchant) fail("USAGE", "--merchant is required");
        const db = getDb();
        const result = clearMerchantDefaultAccount(db, opts.merchant);
        if (!result) fail("NOT_FOUND", `merchant "${opts.merchant}" not found`);
        emit({ merchant_id: opts.merchant, before: result.before, after: null });
      }),
    );
}
