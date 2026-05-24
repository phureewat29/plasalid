import chalk from "chalk";
import inquirer from "inquirer";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  config,
  saveConfig,
  getConfigPath,
  getPlasalidDir,
  getDataDir,
  type PlasalidConfig,
} from "../config.js";
import { generateKey } from "../db/encryption.js";
import { createContextTemplate } from "../ai/context.js";
import { printLogo } from "./logo.js";
import { statusSpinner } from "./ux.js";

const DEFAULT_LOCAL_OPENAI_BASE_URL = "http://localhost:11434/v1";

type Vendor = PlasalidConfig["providerType"];

const RECOMMENDED_MODEL: Record<Exclude<Vendor, "openai-compat">, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.5-pro",
};

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function printBanner(): void {
  console.log("");
  printLogo();
  console.log("");
  console.log(
    "Welcome to Plasalid. Let's get you set up — a few quick questions.",
  );
  console.log("");
  console.log(
    chalk.dim(
      "Time to power up your engine — wire in an AI, pick a model, seal your vault.",
    ),
  );
}

function printSummary(dataDir: string): void {
  console.log("");
  console.log(
    `${chalk.cyan("<°(((><")}  ${chalk.green("Plasalid is configured.")}`,
  );
  console.log(chalk.dim(`Config: ${getConfigPath()}`));
  console.log(chalk.dim(`Data:   ${dataDir}`));
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Run ${chalk.cyan("plasalid data")} to drop your bank / credit-card statement PDFs in.`,
  );
  console.log(`  2. Run ${chalk.cyan("plasalid scan")} to parse them.`);
  console.log(
    `  3. Run ${chalk.cyan("plasalid clarify")} to work through anything the scanner flagged.`,
  );
  console.log(`  4. Run ${chalk.cyan("plasalid")} to chat with your money.`);
  console.log("");
  console.log(
    chalk.dim(
      `  Optional: ${chalk.cyan(`plasalid record "..."`)}${chalk.dim(" to record manual/undocumented transaction, balance, or account at any time.")}`,
    ),
  );
}

/**
 * Each helper prints one leading blank line. Inquirer collapses the resolved
 * prompt to a single line, so each new helper produces exactly one blank row
 * between adjacent questions. passwordPrompt has no `default` because the
 * masked-but-pre-filled state confuses "press Enter to keep".
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
      choices: opts.choices,
      default: opts.default,
    },
  ]);
  return answer[opts.name] as T;
}

async function inputPrompt(opts: {
  name: string;
  message: string;
  default?: string;
  validate?: (v: string) => true | string;
}): Promise<string> {
  console.log("");
  const answer = await inquirer.prompt([
    {
      type: "input",
      name: opts.name,
      message: opts.message,
      default: opts.default,
      validate: opts.validate,
    },
  ]);
  return String(answer[opts.name] ?? "").trim();
}

async function passwordPrompt(opts: {
  name: string;
  message: string;
  validate?: (v: string) => true | string;
}): Promise<string> {
  console.log("");
  const answer = await inquirer.prompt([
    {
      type: "password",
      name: opts.name,
      message: opts.message,
      mask: "*",
      validate: opts.validate,
    },
  ]);
  return String(answer[opts.name] ?? "");
}

function savedModelFor(vendor: Vendor): string {
  switch (vendor) {
    case "anthropic":
      return config.anthropicModel;
    case "openai":
      return config.openaiModel;
    case "gemini":
      return config.geminiModel;
    case "openai-compat":
      return config.openaiCompatModel;
  }
}

async function promptUserName(): Promise<string> {
  return inputPrompt({
    name: "userName",
    message: "What should I call you? (Your name)",
  });
}

async function promptProviderChoice(): Promise<Vendor> {
  return listPrompt<Vendor>({
    name: "vendor",
    message: "Which AI provider would you like to use?",
    choices: [
      { name: "Anthropic", value: "anthropic" },
      { name: "OpenAI", value: "openai" },
      { name: "Google Gemini", value: "gemini" },
      {
        name: "OpenAI Compatible (LM Studio, vLLM, Ollama, other)",
        value: "openai-compat",
      },
    ],
    default: "anthropic",
  });
}

/**
 * Model default: the value previously saved for this vendor, else its
 * recommended flagship. openai-compat has none, so it starts blank and the
 * required-non-empty validator catches blank submissions.
 */
async function promptModelInput(vendor: Vendor): Promise<string> {
  const carriedOver = savedModelFor(vendor);
  const recommended =
    vendor === "openai-compat" ? "" : RECOMMENDED_MODEL[vendor];
  const defaultValue = carriedOver || recommended;

  // openai-compat has no single recommended model — the scanner rasterizes
  // PDFs to PNG on this path, so any non-vision model will fail on scan. Steer
  // the user toward a vision-language model in the prompt.
  const message =
    vendor === "openai-compat"
      ? "Which AI model? (use a vision-language model)"
      : `Which AI model? (recommended: ${RECOMMENDED_MODEL[vendor]})`;

  return inputPrompt({
    name: "model",
    message,
    default: defaultValue || undefined,
    validate: (v) => v.trim().length > 0 || "Required",
  });
}

/**
 * Empty submit silently keeps the existing key when one is on file. Otherwise
 * the validator rejects empty (or accepts empty when `optional`, e.g. local
 * servers that need no auth).
 */
async function promptApiKey(opts: {
  label: string;
  existing: string;
  optional?: boolean;
  prefix?: string;
}): Promise<string> {
  const hasExisting = opts.existing.length > 0;

  const fresh = await passwordPrompt({
    name: "key",
    message: `${opts.label}:`,
    validate: (v) => {
      if (v === "" && (hasExisting || opts.optional)) return true;
      if (opts.prefix && !v.startsWith(opts.prefix)) {
        return `Enter a key starting with ${opts.prefix}...`;
      }
      if (v.length === 0) return "Required";
      return true;
    },
  });
  return fresh === "" && hasExisting ? opts.existing : fresh;
}

async function promptAnthropicCredentials(): Promise<Partial<PlasalidConfig>> {
  const anthropicKey = await promptApiKey({
    label: "Paste your Anthropic API key (https://console.anthropic.com)",
    existing: config.anthropicKey,
    prefix: "sk-",
  });
  const anthropicModel = await promptModelInput("anthropic");
  return { providerType: "anthropic", anthropicKey, anthropicModel };
}

async function promptOpenAICredentials(): Promise<Partial<PlasalidConfig>> {
  const openaiKey = await promptApiKey({
    label: "Paste your OpenAI API key (https://platform.openai.com/api-keys)",
    existing: config.openaiKey,
    prefix: "sk-",
  });
  const openaiModel = await promptModelInput("openai");
  return { providerType: "openai", openaiKey, openaiModel };
}

async function promptGeminiCredentials(): Promise<Partial<PlasalidConfig>> {
  const geminiKey = await promptApiKey({
    label:
      "Paste your Google AI Studio API key (https://aistudio.google.com/apikey)",
    existing: config.geminiKey,
  });
  const geminiModel = await promptModelInput("gemini");
  return { providerType: "gemini", geminiKey, geminiModel };
}

async function promptOpenAICompatCredentials(): Promise<
  Partial<PlasalidConfig>
> {
  const baseURLDefault =
    config.providerType === "openai-compat" && config.openaiCompatBaseURL
      ? config.openaiCompatBaseURL
      : DEFAULT_LOCAL_OPENAI_BASE_URL;

  const openaiCompatBaseURL = await inputPrompt({
    name: "baseURL",
    message: "What's the base URL of your LLM server?",
    default: baseURLDefault,
    validate: (v) =>
      /^https?:\/\//.test(v) || "Must start with http:// or https://",
  });

  const openaiCompatKey = await promptApiKey({
    label: "Paste your LLM server API key",
    existing: config.openaiCompatKey,
    optional: true,
  });

  const openaiCompatModel = await promptModelInput("openai-compat");

  return {
    providerType: "openai-compat",
    openaiCompatBaseURL,
    openaiCompatKey,
    openaiCompatModel,
  };
}

async function promptCredentials(
  vendor: Vendor,
): Promise<Partial<PlasalidConfig>> {
  switch (vendor) {
    case "anthropic":
      return promptAnthropicCredentials();
    case "openai":
      return promptOpenAICredentials();
    case "gemini":
      return promptGeminiCredentials();
    case "openai-compat":
      return promptOpenAICompatCredentials();
  }
}

/**
 * Encryption key is auto-generated. The work is microseconds,
 * but the banner just told the user to "seal your vault" — hold the spinner
 * so the step is visible.
 */
async function sealVault(): Promise<void> {
  const spinner = statusSpinner("Sealing your vault…");
  const start = Date.now();
  if (!config.dbEncryptionKey) {
    saveConfig({ dbEncryptionKey: generateKey() });
  }
  const remaining = 600 - (Date.now() - start);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  spinner.succeed("Vault sealed.");
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

  const userName = await promptUserName();
  const vendor = await promptProviderChoice();
  const credentials = await promptCredentials(vendor);

  saveConfig({
    userName: userName || "User",
    ...credentials,
  });

  await sealVault();
  const dataDir = finalizeDataDir(userName || "User");

  printSummary(dataDir);
}
