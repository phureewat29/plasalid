import type Database from "libsql";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getMemories, deleteMemory } from "../../ai/memory.js";
import {
  listMerchants,
  clearMerchantDefaultAccount,
} from "../../db/queries/merchants.js";

export interface RuleEntry {
  displayId: string;
  text: string;
  forget(db: Database.Database): void;
}

export function collectRules(db: Database.Database): RuleEntry[] {
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

export async function showRules(): Promise<void> {
  const db = getDb();
  const rules = collectRules(db);
  if (rules.length === 0) {
    console.log(
      "No rules yet.\n\n" +
        chalk.dim(
          "Rules accumulate as you clarify questions. Run `plasalid clarify` after a scan.",
        ),
    );
    return;
  }
  const [{ runBrowser }, { RulesBrowser }, { createElement }] = await Promise.all([
    import("../ink/runBrowser.js"),
    import("../ink/RulesBrowser.js"),
    import("react"),
  ]);
  await runBrowser(createElement(RulesBrowser, { rules, db }));
}
