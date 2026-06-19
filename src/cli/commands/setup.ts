import type { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { config as appConfig, getConfigPath, saveConfig, type PlasalidConfig } from "../../config.js";
import { generateKey } from "../../db/encryption.js";
import { currentMode, fail, readSecretFromStdin, runAction } from "../output.js";
import { printConfig, redactConfig } from "./config-cmd.js";

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Set up the harness environment")
    .option("--data-dir <dir>", "data directory")
    .option("--db <path>", "database path")
    .option("--generate-key", "generate a new encryption key")
    .option("--encryption-key-stdin", "read an encryption key from stdin")
    .option("--locale <locale>", "locale")
    .option("--currency <code>", "default currency code")
    .option("--user-name <name>", "user display name")
    .option("--force", "overwrite existing configuration")
    .action(
      runAction(async (opts: any) => {
        if (opts.generateKey && opts.encryptionKeyStdin) {
          fail("USAGE", "--generate-key and --encryption-key-stdin are mutually exclusive");
        }

        const configPath = getConfigPath();
        if (existsSync(configPath) && !opts.force) {
          fail("INVALID", "configuration already exists", {
            hint: `re-run with --force to overwrite ${configPath}`,
          });
        }

        // Resolve values: an explicit flag wins, otherwise fall back to the
        // already-resolved (env > default) value the config singleton loaded
        // at process start — there is no config.json yet on a fresh setup, so
        // that singleton already reflects "env > default".
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

        // Open once to run the migration against the freshly-configured db path.
        const { getDb } = await import("../../db/connection.js");
        getDb();

        const { createContextTemplate } = await import("../../context.js");
        createContextTemplate(userName);

        printConfig(currentMode(), {
          ...redactConfig(appConfig),
          created: { config: configPath, db: dbPath, data_dir: dataDir },
        });
      }),
    );
}
