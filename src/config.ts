import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { resolve } from "path";
import { homedir } from "os";

export interface PlasalidConfig {
  providerType: "anthropic" | "openai" | "gemini" | "openai-compat";
  anthropicKey: string;
  anthropicModel: string;
  openaiKey: string;
  openaiModel: string;
  geminiKey: string;
  geminiModel: string;
  openaiCompatKey: string;
  openaiCompatBaseURL: string;
  openaiCompatModel: string;
  displayLocale: string;
  displayCurrency: string;
  dbPath: string;
  dbEncryptionKey: string;
  dataDir: string;
  userName: string;
  thinkingBudget: number;
}

const PLASALID_DIR = resolve(homedir(), ".plasalid");

export function getPlasalidDir(): string {
  return PLASALID_DIR;
}

export function getConfigPath(): string {
  return resolve(PLASALID_DIR, "config.json");
}

export function getDataDir(): string {
  return config.dataDir;
}

function loadFileConfig(): Partial<PlasalidConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function buildConfig(): PlasalidConfig {
  const file = loadFileConfig();
  // Precedence: env > file > default. Env is checked first so a shell-exported
  // override always wins over whatever is in ~/.plasalid/config.json.
  return {
    providerType:
      (process.env.PLASALID_PROVIDER as PlasalidConfig["providerType"]) ||
      (file.providerType as PlasalidConfig["providerType"]) ||
      "anthropic",
    anthropicKey: process.env.ANTHROPIC_API_KEY || file.anthropicKey || "",
    anthropicModel:
      process.env.ANTHROPIC_MODEL || file.anthropicModel || "claude-sonnet-4-6",
    openaiKey: process.env.OPENAI_API_KEY || file.openaiKey || "",
    openaiModel: process.env.OPENAI_MODEL || file.openaiModel || "gpt-5.4-mini",
    openaiCompatKey:
      process.env.OPENAI_COMPAT_API_KEY || file.openaiCompatKey || "",
    openaiCompatBaseURL:
      process.env.OPENAI_COMPAT_BASE_URL || file.openaiCompatBaseURL || "",
    openaiCompatModel:
      process.env.OPENAI_COMPAT_MODEL || file.openaiCompatModel || "",
    geminiKey: process.env.GEMINI_API_KEY || file.geminiKey || "",
    geminiModel:
      process.env.GEMINI_MODEL || file.geminiModel || "gemini-2.5-pro",
    displayLocale: file.displayLocale || "th-TH",
    displayCurrency: file.displayCurrency || "THB",
    dbPath:
      process.env.PLASALID_DB_PATH ||
      file.dbPath ||
      resolve(PLASALID_DIR, "db.sqlite"),
    dbEncryptionKey:
      process.env.PLASALID_DB_ENCRYPTION_KEY || file.dbEncryptionKey || "",
    dataDir:
      process.env.PLASALID_DATA_DIR ||
      file.dataDir ||
      resolve(PLASALID_DIR, "data"),
    userName: file.userName || "User",
    thinkingBudget: file.thinkingBudget ?? 8000,
  };
}

export const config = buildConfig();

export function isConfigured(): boolean {
  switch (config.providerType) {
    case "anthropic":
      return !!config.anthropicKey;
    case "openai":
      return !!config.openaiKey;
    case "gemini":
      return !!config.geminiKey;
    case "openai-compat":
      return !!config.openaiCompatBaseURL;
  }
}

export function getActiveModel(): string {
  switch (config.providerType) {
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

export function saveConfig(partial: Partial<PlasalidConfig>): void {
  const configPath = getConfigPath();
  if (!existsSync(PLASALID_DIR)) mkdirSync(PLASALID_DIR, { recursive: true });

  const existing = loadFileConfig();
  const merged = { ...existing, ...partial };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {}

  Object.assign(config, merged);
}
