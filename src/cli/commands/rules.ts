import type Database from "libsql";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getMemories, deleteMemory } from "../../ai/memory.js";
import {
  listMerchants,
  clearMerchantDefaultAccount,
} from "../../db/queries/merchants.js";

interface RuleEntry {
  displayId: string;
  text: string;
  forget(db: Database.Database): void;
}

export interface ForgetMatch {
  displayId: string;
  text: string;
}

export type ForgetOutcome =
  | { ok: true; matched: ForgetMatch[] }
  | { ok: false; error: string };

function collectRules(db: Database.Database): RuleEntry[] {
  const out: RuleEntry[] = [];

  for (const m of getMemories(db)) {
    out.push({
      displayId: `mem:${m.id}`,
      text: m.content,
      forget: (db) => {
        deleteMemory(db, m.id);
      },
    });
  }

  const merchants = listMerchants(db, { withDefaultOnly: true });
  merchants.forEach((m, i) => {
    out.push({
      displayId: `mch:${i + 1}`,
      text: `${m.canonical_name} → ${m.default_account_id}`,
      forget: (db) => {
        clearMerchantDefaultAccount(db, m.id);
      },
    });
  });

  return out;
}

export function renderRules(db: Database.Database): string {
  const rules = collectRules(db);
  if (rules.length === 0) {
    return (
      "No rules yet.\n\n" +
      chalk.dim(
        "Rules accumulate as you clarify questions. Run `plasalid clarify` after a scan.",
      )
    );
  }
  const width = Math.max(...rules.map((r) => r.displayId.length));
  const lines = [chalk.bold(`Rules (${rules.length}):`)];
  for (const r of rules) {
    lines.push(`  ${chalk.cyan(r.displayId.padEnd(width))}  ${r.text}`);
  }
  lines.push("");
  lines.push(chalk.dim("To remove: plasalid forget <regex>"));
  return lines.join("\n");
}

export function forgetRules(
  db: Database.Database,
  pattern: string,
): ForgetOutcome {
  let re: RegExp;
  try {
    re = new RegExp(`^${pattern}$`);
  } catch (err: unknown) {
    return { ok: false, error: `Invalid regex /${pattern}/: ${err instanceof Error ? err.message : String(err)}` };
  }
  const snapshot = collectRules(db);
  const hits = snapshot.filter((r) => re.test(r.displayId));
  if (!hits.length) {
    return {
      ok: false,
      error: `No rule matches /${pattern}/. Run \`plasalid rules\` to list ids.`,
    };
  }
  const matched: ForgetMatch[] = hits.map((r) => {
    r.forget(db);
    return { displayId: r.displayId, text: r.text };
  });
  return { ok: true, matched };
}

export function showRules(): void {
  console.log(renderRules(getDb()));
}

export function forgetRule(pattern: string): void {
  const outcome = forgetRules(getDb(), pattern);
  if (!outcome.ok) {
    console.error(chalk.red(outcome.error));
    process.exitCode = 1;
    return;
  }
  const width = Math.max(...outcome.matched.map((m) => m.displayId.length));
  for (const m of outcome.matched) {
    console.log(`Forgot ${chalk.cyan(m.displayId.padEnd(width))}  ${m.text}`);
  }
}
