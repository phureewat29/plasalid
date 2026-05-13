import chalk from "chalk";
import inquirer from "inquirer";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  config,
  saveConfig,
  getConfigPath,
  isConfigured,
  getPlasalidDir,
  getDataDir,
} from "../config.js";
import { generateKey } from "../db/encryption.js";
import { createContextTemplate } from "../ai/context.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export async function runSetup(): Promise<void> {
  console.log(chalk.bold("Plasalid setup"));
  console.log(
    chalk.dim(
      "The local-first data layer for personal finance. Your data stays on this machine; only redacted requests go to Anthropic.",
    ),
  );
  console.log("");

  ensureDir(getPlasalidDir());

  const envApiKey = process.env.ANTHROPIC_API_KEY?.trim() || "";
  const envUserName = process.env.PLASALID_USER_NAME?.trim() || "";
  const envDetected: string[] = [];
  if (envApiKey) envDetected.push("ANTHROPIC_API_KEY");
  if (envUserName) envDetected.push("PLASALID_USER_NAME");
  if (envDetected.length > 0) {
    console.log(
      chalk.dim(`Pre-filling from environment: ${envDetected.join(", ")}.`),
    );
    console.log("");
  }

  const { key, model, userName } = await inquirer.prompt([
    {
      type: "password",
      name: "key",
      message: "Anthropic API key (https://console.anthropic.com):",
      mask: "*",
      default: envApiKey || config.anthropicKey || undefined,
      validate: (v: string) =>
        v.startsWith("sk-") ? true : "Enter a key starting with sk-...",
    },
    {
      type: "input",
      name: "model",
      message: "Model name:",
      default: config.model || DEFAULT_MODEL,
    },
    {
      type: "input",
      name: "userName",
      message: "Your name:",
      default:
        envUserName || (config.userName === "User" ? "" : config.userName),
    },
  ]);
  saveConfig({
    anthropicKey: key,
    model: model || DEFAULT_MODEL,
    userName: userName || "User",
  });

  if (!config.dbEncryptionKey) {
    const { mode } = await inquirer.prompt([
      {
        type: "list",
        name: "mode",
        message: "Encrypt the local database?",
        choices: [
          { name: "Yes (generate a strong key automatically)", value: "auto" },
          { name: "Yes (I'll provide my own passphrase)", value: "manual" },
          { name: "No (store plaintext)", value: "none" },
        ],
        default: "auto",
      },
    ]);
    if (mode === "auto") {
      saveConfig({ dbEncryptionKey: generateKey() });
      console.log(
        chalk.dim(
          `Generated a new DB encryption key and saved it to ${getConfigPath()}.`,
        ),
      );
    } else if (mode === "manual") {
      const { key: passphrase } = await inquirer.prompt([
        {
          type: "password",
          name: "key",
          message: "Passphrase:",
          mask: "*",
          validate: (v: string) =>
            v.length >= 8 || "Use at least 8 characters.",
        },
      ]);
      saveConfig({ dbEncryptionKey: passphrase });
    }
  } else {
    console.log(chalk.dim("DB encryption key already set."));
  }

  const dataDir = config.dataDir || resolve(getPlasalidDir(), "data");
  saveConfig({ dataDir });
  ensureDir(getDataDir());
  createContextTemplate(config.userName);

  console.log("");
  console.log(chalk.green("✓ Plasalid is configured."));
  console.log(chalk.dim(`Config: ${getConfigPath()}`));
  console.log(chalk.dim(`Data: ${dataDir}`));
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Run ${chalk.cyan("plasalid data")} to open ${chalk.cyan(getDataDir())} in your file explorer, then drop PDFs in.`,
  );
  console.log(`  2. Run ${chalk.cyan("plasalid scan")} to scan them.`);
  console.log(
    `  3. Run ${chalk.cyan("plasalid")} (no args) to chat with your data.`,
  );
}

export function ensureConfigured(): void {
  if (!isConfigured()) {
    console.error(
      chalk.red("Plasalid is not configured. Run `plasalid setup` first."),
    );
    process.exit(1);
  }
}
