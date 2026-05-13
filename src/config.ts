import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

export interface PlasalidConfig {
  anthropicKey: string;
  model: string;
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
  return {
    anthropicKey: file.anthropicKey || process.env.ANTHROPIC_API_KEY || "",
    model: file.model || process.env.PLASALID_MODEL || "claude-sonnet-4-6",
    displayLocale: file.displayLocale || "th-TH",
    displayCurrency: file.displayCurrency || "THB",
    dbPath: file.dbPath || process.env.PLASALID_DB_PATH || resolve(PLASALID_DIR, "db.sqlite"),
    dbEncryptionKey: file.dbEncryptionKey || process.env.PLASALID_DB_ENCRYPTION_KEY || "",
    dataDir: file.dataDir || process.env.PLASALID_DATA_DIR || resolve(PLASALID_DIR, "data"),
    userName: file.userName || "User",
    thinkingBudget: file.thinkingBudget ?? 8000,
  };
}

export const config = buildConfig();

export function isConfigured(): boolean {
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
