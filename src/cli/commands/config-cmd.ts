import type { Command } from "commander";
import { createHash } from "crypto";
import { config as appConfig, getConfigPath, getDataDir, saveConfig, type PlasalidConfig } from "../../config.js";
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
    ? { set: true, fingerprint: `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}` }
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

export function registerConfig(program: Command): void {
  const configCmd = program.command("config").description("Manage harness configuration");

  configCmd
    .command("show")
    .description("Show the current configuration")
    .action(
      runAction(async () => {
        printConfig(currentMode(), redactConfig(appConfig));
      }),
    );

  configCmd
    .command("set")
    .description("Update configuration values")
    .option("--data-dir <dir>", "data directory")
    .option("--db <path>", "database path")
    .option("--locale <locale>", "locale")
    .option("--currency <code>", "default currency code")
    .option("--user-name <name>", "user display name")
    .option("--encryption-key-stdin", "read an encryption key from stdin")
    .action(
      runAction(async (opts: any) => {
        const patch: Partial<PlasalidConfig> = {};
        if (opts.dataDir !== undefined) patch.dataDir = opts.dataDir;
        if (opts.db !== undefined) patch.dbPath = opts.db;
        if (opts.locale !== undefined) patch.displayLocale = opts.locale;
        if (opts.currency !== undefined) patch.displayCurrency = opts.currency;
        if (opts.userName !== undefined) patch.userName = opts.userName;
        if (opts.encryptionKeyStdin) patch.dbEncryptionKey = await readSecretFromStdin();

        if (Object.keys(patch).length === 0) {
          fail(
            "USAGE",
            "at least one of --data-dir, --db, --locale, --currency, --user-name, --encryption-key-stdin is required",
          );
        }

        saveConfig(patch);
        printConfig(currentMode(), redactConfig(appConfig));
      }),
    );

  configCmd
    .command("path")
    .description("Show the configuration file path")
    .action(
      runAction(async () => {
        const result = { config: getConfigPath(), db: appConfig.dbPath, data_dir: getDataDir() };
        printConfig(currentMode(), result);
      }),
    );
}
