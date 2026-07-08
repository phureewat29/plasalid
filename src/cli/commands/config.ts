import type { Command } from "commander";
import { mkdirSync } from "fs";
import {
  config as appConfig,
  getConfigPath,
  keyFingerprint,
  saveConfig,
  type PlasalidConfig,
} from "../../config.js";
import { generateKey } from "../../db/encryption.js";
import { currentMode, emit, fail, readSecretFromStdin, runAction, type OutputMode } from "../output.js";

type RedactedConfig = Omit<PlasalidConfig, "dbEncryptionKey"> & {
  dbEncryptionKey: { set: boolean; fingerprint?: string };
};

// The only secret left in the config after the harness cut is dbEncryptionKey
// (the provider API keys are gone). Surface it as {set, fingerprint} rather than
// printing the passphrase verbatim into shells, logs, and bug reports.
export function redactConfig(cfg: PlasalidConfig): RedactedConfig {
  const key = cfg.dbEncryptionKey;
  const dbEncryptionKey = key
    ? { set: true, fingerprint: keyFingerprint(key) }
    : { set: false };
  return { ...cfg, dbEncryptionKey };
}

/** Flatten a (possibly one-level-nested) object into label/value rows for human display. */
function flattenRows(obj: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        rows.push([`${k}.${nk}`, String(nv)]);
      }
    } else {
      rows.push([k, String(v)]);
    }
  }
  return rows;
}

export function printConfig(mode: OutputMode, data: Record<string, unknown>): void {
  if (mode.json) {
    emit(data);
    return;
  }
  const rows = flattenRows(data);
  if (!mode.tty) {
    process.stdout.write(rows.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
    return;
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) process.stdout.write(`${k.padEnd(width)}  ${v}\n`);
}

interface ConfigConvergeOptions {
  dataDir?: string;
  db?: string;
  generateKey?: boolean;
  encryptionKeyStdin?: boolean;
  locale?: string;
  currency?: string;
  userName?: string;
}

/** True when the caller passed at least one converge flag. Bare `config` with
 *  none is a read (show); with any, it converges (create-or-update). */
function hasConvergeFlags(opts: ConfigConvergeOptions): boolean {
  return (
    opts.dataDir !== undefined ||
    opts.db !== undefined ||
    opts.generateKey === true ||
    opts.encryptionKeyStdin === true ||
    opts.locale !== undefined ||
    opts.currency !== undefined ||
    opts.userName !== undefined
  );
}

/**
 * Idempotent configure: ensure the data dir exists, persist the resolved
 * settings, open the db (running the migration), and seed context.md if
 * absent. The first run initializes a fresh install; later runs update only
 * what the caller passes. Each value resolves to an explicit flag or the
 * already-loaded (env > file > default) singleton value, so re-writing an
 * unchanged value is a no-op — which is what makes a re-run idempotent.
 */
async function convergeConfig(opts: ConfigConvergeOptions): Promise<void> {
  if (opts.generateKey && opts.encryptionKeyStdin) {
    fail("USAGE", "--generate-key and --encryption-key-stdin are mutually exclusive");
  }

  const dataDir: string = opts.dataDir ?? appConfig.dataDir;
  const dbPath: string = opts.db ?? appConfig.dbPath;
  const displayLocale: string = opts.locale ?? appConfig.displayLocale;
  const displayCurrency: string = opts.currency ?? appConfig.displayCurrency;
  const userName: string = opts.userName ?? appConfig.userName;

  mkdirSync(dataDir, { recursive: true });

  const patch: Partial<PlasalidConfig> = {
    dataDir,
    dbPath,
    displayLocale,
    displayCurrency,
    userName,
  };
  if (opts.generateKey) {
    patch.dbEncryptionKey = generateKey();
  } else if (opts.encryptionKeyStdin) {
    patch.dbEncryptionKey = await readSecretFromStdin();
  }

  saveConfig(patch);

  // Open once to run the migration against the (freshly) configured db path.
  const { getDb } = await import("../../db/connection.js");
  getDb();

  // Seed the context template only when absent — createContextTemplate is a
  // no-op if the file already exists, so a converge never clobbers edits.
  const { createContextTemplate } = await import("../../context.js");
  createContextTemplate(userName);

  printConfig(currentMode(), {
    ...redactConfig(appConfig),
    created: { config: getConfigPath(), db: dbPath, data_dir: dataDir },
  });
}

export function registerConfig(program: Command): void {
  const configCmd = program
    .command("config")
    // config has a bare converge action AND a `show` subcommand. Positional
    // options bind flags placed after the subcommand name to the subcommand
    // rather than being swallowed by the parent action (mirrors ledger; see
    // program.ts's root note on enablePositionalOptions).
    .enablePositionalOptions()
    .description("Configure the harness (bare with flags converges; bare with none shows)")
    .option("--data-dir <dir>", "data directory")
    .option("--db <path>", "database path")
    .option("--generate-key", "generate a new encryption key")
    .option("--encryption-key-stdin", "read an encryption key from stdin")
    .option("--locale <locale>", "locale")
    .option("--currency <code>", "default currency code")
    .option("--user-name <name>", "user display name")
    .action(
      runAction(async (opts: ConfigConvergeOptions) => {
        if (hasConvergeFlags(opts)) {
          await convergeConfig(opts);
        } else {
          printConfig(currentMode(), redactConfig(appConfig));
        }
      }),
    );

  configCmd
    .command("show")
    .description("Show the current configuration")
    .action(
      runAction(async () => {
        printConfig(currentMode(), redactConfig(appConfig));
      }),
    );
}
