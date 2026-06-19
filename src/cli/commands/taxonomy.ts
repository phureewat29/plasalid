import type { Command } from "commander";
import chalk from "chalk";
import {
  ACCOUNT_TYPE_DESCRIPTIONS,
  ALL_THAI_INSTITUTIONS,
  SUGGESTED_ASSET_SUBTYPES,
  SUGGESTED_LIABILITY_SUBTYPES,
  SUGGESTED_EXPENSE_SUBTYPES,
  SUGGESTED_INCOME_SUBTYPES,
  type AccountType,
} from "../../accounts/taxonomy.js";
import { currentMode, emit, runAction } from "../output.js";

interface Institution {
  code: string;
  label: string;
  kind: string;
  notes: string | null;
}

interface TaxonomyDump {
  institutions: Institution[];
  suggested_subtypes: Record<string, string[]>;
  account_types: Record<AccountType, string>;
}

function buildTaxonomy(): TaxonomyDump {
  return {
    institutions: ALL_THAI_INSTITUTIONS.map((i) => ({
      code: i.code,
      label: i.label,
      kind: i.kind,
      notes: i.notes ?? null,
    })),
    suggested_subtypes: {
      asset: SUGGESTED_ASSET_SUBTYPES,
      liability: SUGGESTED_LIABILITY_SUBTYPES,
      expense: SUGGESTED_EXPENSE_SUBTYPES,
      income: SUGGESTED_INCOME_SUBTYPES,
    },
    account_types: ACCOUNT_TYPE_DESCRIPTIONS,
  };
}

function renderPlain(data: TaxonomyDump): void {
  const lines: string[] = [];
  for (const inst of data.institutions) {
    lines.push(["institution", inst.kind, inst.code, inst.label, inst.notes ?? ""].join("\t"));
  }
  for (const [type, subtypes] of Object.entries(data.suggested_subtypes)) {
    for (const s of subtypes) lines.push(["suggested_subtype", type, s].join("\t"));
  }
  for (const [type, desc] of Object.entries(data.account_types)) {
    lines.push(["account_type", type, desc].join("\t"));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function renderTty(data: TaxonomyDump, color: boolean): void {
  const bold = (s: string): string => (color ? chalk.bold.yellow(s) : s);
  const dim = (s: string): string => (color ? chalk.dim(s) : s);

  const byKind = new Map<string, Institution[]>();
  for (const inst of data.institutions) {
    const arr = byKind.get(inst.kind) ?? [];
    arr.push(inst);
    byKind.set(inst.kind, arr);
  }

  for (const [kind, insts] of byKind) {
    process.stdout.write(bold(kind) + "\n");
    const codeWidth = Math.max(...insts.map((i) => i.code.length));
    for (const inst of insts) {
      const notes = inst.notes ? "  " + dim(`— ${inst.notes}`) : "";
      process.stdout.write(`  ${inst.code.padEnd(codeWidth)}  ${inst.label}${notes}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write(bold("Suggested subtypes") + "\n");
  for (const [type, subtypes] of Object.entries(data.suggested_subtypes)) {
    process.stdout.write(`  ${type.padEnd(12)}${subtypes.join(", ")}\n`);
  }

  process.stdout.write("\n" + bold("Account types") + "\n");
  for (const [type, desc] of Object.entries(data.account_types)) {
    process.stdout.write(`  ${type.padEnd(12)}${desc}\n`);
  }
}

export function registerTaxonomy(program: Command): void {
  program
    .command("taxonomy")
    .description("Dump the Thai institution registry")
    .action(
      runAction(async () => {
        const data = buildTaxonomy();
        const mode = currentMode();
        if (mode.json) {
          emit(data);
          return;
        }
        if (mode.tty) {
          renderTty(data, mode.color);
          return;
        }
        renderPlain(data);
      }),
    );
}
