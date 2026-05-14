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
  type PlasalidConfig,
} from "../config.js";
import { generateKey } from "../db/encryption.js";
import { createContextTemplate } from "../ai/context.js";
import { printLogo } from "./logo.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";

type ProviderType = PlasalidConfig["providerType"];

interface EnvDefaults {
  anthropicKey: string;
  userName: string;
  openaiBaseURL: string;
  openaiKey: string;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readEnvDefaults(): EnvDefaults {
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
    userName: process.env.PLASALID_USER_NAME?.trim() || "",
    openaiBaseURL: process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || "",
    openaiKey: process.env.OPENAI_COMPATIBLE_API_KEY?.trim() || "",
  };
}

function printBanner(): void {
  console.log("");
  printLogo();
  console.log("");
  console.log(
    "Welcome to Plasalid. Let's get you set up — a few quick questions.",
  );
  console.log("");
}

function printSummary(dataDir: string): void {
  console.log("");
  console.log(chalk.green("✓ Plasalid is configured."));
  console.log(chalk.dim(`Config: ${getConfigPath()}`));
  console.log(chalk.dim(`Data:   ${dataDir}`));
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Run ${chalk.cyan("plasalid data")} to drop your bank/credit card statments PDFs in.`,
  );
  console.log(
    `  2. Run ${chalk.cyan("plasalid scan")} to allow Plasalid to scan them.`,
  );
  console.log(
    `  3. Run ${chalk.cyan("plasalid")} to chat with your financial data.`,
  );
}

/**
 * Wraps inquirer's list prompt with a blank line above and below, and inserts
 * a Separator(" ") row above the first choice so the question and the first
 * option don't crowd each other. Mirrors `makePromptUser` in `src/cli/ux.ts`.
 */
async function listPrompt<T extends string>(opts: {
  name: string;
  message: string;
  choices: { name: string; value: T }[];
  default?: T;
}): Promise<T> {
  console.log("");
  const answer = await inquirer.prompt([
    {
      type: "list",
      name: opts.name,
      message: opts.message,
      choices: [new inquirer.Separator(" "), ...opts.choices],
      default: opts.default,
    },
  ]);
  console.log("");
  return answer[opts.name] as T;
}

async function promptUserName(env: EnvDefaults): Promise<string> {
  const { userName } = await inquirer.prompt([
    {
      type: "input",
      name: "userName",
      message: "What should I call you? (Your name)",
      default:
        env.userName || (config.userName === "User" ? "" : config.userName),
    },
  ]);
  return String(userName || "").trim();
}

async function promptProviderChoice(): Promise<ProviderType> {
  return listPrompt<ProviderType>({
    name: "providerChoice",
    message: "Which AI provider would you like to use?",
    choices: [
      { name: "Anthropic (Claude)", value: "anthropic" },
      {
        name: "OpenAI compatible (OpenAI, LM Studio, vLLM, Ollama)",
        value: "openai-compatible",
      },
    ],
    default: "anthropic",
  });
}

async function promptAnthropicCredentials(
  env: EnvDefaults,
): Promise<Partial<PlasalidConfig>> {
  const { key, model } = await inquirer.prompt([
    {
      type: "password",
      name: "key",
      message: "Paste your Anthropic API key (https://console.anthropic.com):",
      mask: "*",
      default: env.anthropicKey || config.anthropicKey || undefined,
      validate: (v: string) =>
        v.startsWith("sk-") ? true : "Enter a key starting with sk-...",
    },
    {
      type: "input",
      name: "model",
      message: "Which Claude model?",
      default:
        config.providerType === "anthropic" && config.model
          ? config.model
          : DEFAULT_ANTHROPIC_MODEL,
    },
  ]);
  return {
    anthropicKey: key,
    model: model || DEFAULT_ANTHROPIC_MODEL,
  };
}

async function promptOpenAICompatCredentials(
  env: EnvDefaults,
): Promise<Partial<PlasalidConfig>> {
  const { baseURL, apiKey, model } = await inquirer.prompt([
    {
      type: "input",
      name: "baseURL",
      message: "What's the base URL of your OpenAI-compatible server?",
      default:
        env.openaiBaseURL ||
        config.openaiCompatibleBaseURL ||
        DEFAULT_OPENAI_BASE_URL,
      validate: (v: string) =>
        /^https?:\/\//.test(v) || "Must start with http:// or https://",
    },
    {
      type: "password",
      name: "apiKey",
      message: "API key (leave blank if your server doesn't need one):",
      mask: "*",
      default: env.openaiKey || config.openaiCompatibleKey || undefined,
    },
    {
      type: "input",
      name: "model",
      message:
        "Which model? (e.g. gpt-5, qwen3-coder:480b, deepseek-v3.1:671b)",
      default:
        config.providerType === "openai-compatible" && config.model
          ? config.model
          : "",
      validate: (v: string) => v.trim().length > 0 || "Required",
    },
  ]);
  return {
    openaiCompatibleBaseURL: baseURL,
    openaiCompatibleKey: apiKey || "",
    model: model.trim(),
  };
}

async function promptCredentials(
  provider: ProviderType,
  env: EnvDefaults,
): Promise<Partial<PlasalidConfig>> {
  return provider === "openai-compatible"
    ? promptOpenAICompatCredentials(env)
    : promptAnthropicCredentials(env);
}

async function ensureEncryptionKey(): Promise<void> {
  if (config.dbEncryptionKey) {
    console.log("");
    console.log(chalk.dim("Using the encryption key already on file."));
    return;
  }
  const mode = await listPrompt<"auto" | "manual" | "none">({
    name: "mode",
    message: "Encrypt the local database? (recommended)",
    choices: [
      { name: "Yes (generate a strong key automatically)", value: "auto" },
      { name: "Yes (I'll provide my own passphrase)", value: "manual" },
      { name: "No (store plaintext)", value: "none" },
    ],
    default: "auto",
  });
  if (mode === "auto") {
    saveConfig({ dbEncryptionKey: generateKey() });
    console.log(
      chalk.dim(
        `Generated a new DB encryption key and saved it to ${getConfigPath()}.`,
      ),
    );
    return;
  }
  if (mode === "manual") {
    const { key: passphrase } = await inquirer.prompt([
      {
        type: "password",
        name: "key",
        message: "Choose a passphrase (at least 8 characters):",
        mask: "*",
        validate: (v: string) => v.length >= 8 || "Use at least 8 characters.",
      },
    ]);
    saveConfig({ dbEncryptionKey: passphrase });
  }
}

function finalizeDataDir(userName: string): string {
  const dataDir = config.dataDir || resolve(getPlasalidDir(), "data");
  saveConfig({ dataDir });
  ensureDir(getDataDir());
  createContextTemplate(userName);
  return dataDir;
}

export async function runSetup(): Promise<void> {
  printBanner();
  ensureDir(getPlasalidDir());

  const env = readEnvDefaults();

  const userName = await promptUserName(env);
  const provider = await promptProviderChoice();
  const credentials = await promptCredentials(provider, env);

  saveConfig({
    providerType: provider,
    userName: userName || "User",
    ...credentials,
  });

  await ensureEncryptionKey();
  const dataDir = finalizeDataDir(userName || "User");

  printSummary(dataDir);
}

export function ensureConfigured(): void {
  if (!isConfigured()) {
    console.error(
      chalk.red("Plasalid is not configured. Run `plasalid setup` first."),
    );
    process.exit(1);
  }
}
