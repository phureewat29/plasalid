import type { Command } from "commander";
import type Database from "libsql";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getConfigPath, getDataDir } from "../../config.js";
import { getVersion } from "../../setup/install.js";
import { EXIT, currentMode, emit, emitList, runAction, type Column } from "../output.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const HARD_CHECKS = new Set(["db_open", "schema_tables_present"]);
const REQUIRED_TABLES = ["accounts", "transactions", "questions"];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push({ name: "config_exists", ok: existsSync(getConfigPath()) });

  let db: Database.Database | null = null;
  try {
    const { getDb } = await import("../../db/connection.js");
    db = getDb();
    checks.push({ name: "db_open", ok: true });
  } catch (err) {
    checks.push({ name: "db_open", ok: false, detail: errMsg(err) });
  }

  try {
    const dir = getDataDir();
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-probe-${randomUUID()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    checks.push({ name: "data_dir_writable", ok: true });
  } catch (err) {
    checks.push({ name: "data_dir_writable", ok: false, detail: errMsg(err) });
  }

  try {
    await import("mupdf");
    checks.push({ name: "mupdf_loads", ok: true });
  } catch (err) {
    checks.push({ name: "mupdf_loads", ok: false, detail: errMsg(err) });
  }

  if (db) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
        .all(...REQUIRED_TABLES) as { name: string }[];
      const present = new Set(rows.map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
      checks.push({
        name: "schema_tables_present",
        ok: missing.length === 0,
        detail: missing.length ? `missing: ${missing.join(", ")}` : undefined,
      });
    } catch (err) {
      checks.push({ name: "schema_tables_present", ok: false, detail: errMsg(err) });
    }
  } else {
    checks.push({ name: "schema_tables_present", ok: false, detail: "database not open" });
  }

  checks.push(skillPackCheck());

  return checks;
}

/** Informational (never a HARD_CHECK): whether the skill pack is installed
 *  and its VERSION matches this CLI. Prefers cwd (./.claude) over global. */
function skillPackCheck(): Check {
  const candidates = [
    join(process.cwd(), ".claude", "skills", "plasalid", "VERSION"),
    join(homedir(), ".claude", "skills", "plasalid", "VERSION"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) return { name: "skill_pack", ok: true, detail: "not installed" };

  const installed = readFileSync(found, "utf8").trim();
  const cli = getVersion();
  if (installed !== cli) {
    return {
      name: "skill_pack",
      ok: false,
      detail: `installed ${installed}, cli ${cli} — refresh the skill (plasalid setup --force) or upgrade the CLI (npm install -g plasalid@latest)`,
    };
  }
  return { name: "skill_pack", ok: true, detail: `installed ${installed}` };
}

const CHECK_COLUMNS: Column<Check>[] = [
  { header: "check", value: (r) => r.name },
  { header: "ok", value: (r) => (r.ok ? "yes" : "no") },
  { header: "detail", value: (r) => r.detail ?? "" },
];

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the harness environment")
    .action(
      runAction(async () => {
        const checks = await runChecks();
        const ok = checks.filter((c) => HARD_CHECKS.has(c.name)).every((c) => c.ok);

        const mode = currentMode();
        if (mode.json) {
          emit({ checks, ok });
        } else {
          emitList(checks, CHECK_COLUMNS);
          const line = `overall: ${ok ? "ready" : "not ready"}`;
          process.stdout.write((mode.color ? (ok ? chalk.green(line) : chalk.red(line)) : line) + "\n");
        }
        if (!ok) process.exitCode = EXIT.NOT_READY;
      }),
    );
}
