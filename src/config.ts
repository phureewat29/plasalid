import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

export interface PlasalidConfig {
  anthropicKey: string;
  model: string;
  providerType: "anthropic" | "openai-compatible";
  openaiCompatibleKey: string;
  openaiCompatibleBaseURL: string;
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
    anthropicKey: process.env.ANTHROPIC_API_KEY || file.anthropicKey || "",
    model: process.env.PLASALID_MODEL || file.model || "claude-sonnet-4-6",
    providerType:
      (process.env.PLASALID_PROVIDER as PlasalidConfig["providerType"]) ||
      (file.providerType as PlasalidConfig["providerType"]) ||
      "anthropic",
    openaiCompatibleKey: process.env.OPENAI_COMPATIBLE_API_KEY || file.openaiCompatibleKey || "",
    openaiCompatibleBaseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || file.openaiCompatibleBaseURL || "",
    displayLocale: file.displayLocale || "th-TH",
    displayCurrency: file.displayCurrency || "THB",
    dbPath: process.env.PLASALID_DB_PATH || file.dbPath || resolve(PLASALID_DIR, "db.sqlite"),
    dbEncryptionKey: process.env.PLASALID_DB_ENCRYPTION_KEY || file.dbEncryptionKey || "",
    dataDir: process.env.PLASALID_DATA_DIR || file.dataDir || resolve(PLASALID_DIR, "data"),
    userName: file.userName || "User",
    thinkingBudget: file.thinkingBudget ?? 8000,
  };
}

export const config = buildConfig();

export function isConfigured(): boolean {
  if (config.providerType === "openai-compatible") {
    return !!config.openaiCompatibleBaseURL;
  }
  return !!config.anthropicKey;
}

export function saveConfig(partial: Partial<PlasalidConfig>): void {
  const configPath = getConfigPath();
  if (!existsSync(PLASALID_DIR)) mkdirSync(PLASALID_DIR, { recursive: true });

  const existing = loadFileConfig();
  const merged = { ...existing, ...partial };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch {}

  Object.assign(config, merged);
}
