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
  displayLocale: string;
  displayCurrency: string;
  dbPath: string;
  dbEncryptionKey: string;
  dataDir: string;
  userName: string;
}

/** The persisted config keys. Reads ignore any other (legacy) keys, and
 *  saveConfig writes ONLY these — so legacy provider fields disappear on the
 *  next write rather than being carried forward. */
const CONFIG_KEYS: readonly (keyof PlasalidConfig)[] = [
  "displayLocale",
  "displayCurrency",
  "dbPath",
  "dbEncryptionKey",
  "dataDir",
  "userName",
];

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

// Scratch space for decrypted/rasterized artifacts handed to external agent CLIs.
// Env override keeps it redirectable in tests without touching the real home dir.
export function getCacheDir(): string {
  return process.env.PLASALID_CACHE_DIR || resolve(PLASALID_DIR, "cache");
}

function loadFileConfig(): Partial<PlasalidConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    // Unknown/legacy keys (e.g. old provider settings) are tolerated on read —
    // buildConfig only reads the surviving fields below, and pickConfigFields
    // strips everything else on the next write.
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Project an arbitrary object down to just the surviving config keys. */
function pickConfigFields(obj: Record<string, unknown>): Partial<PlasalidConfig> {
  const out: Partial<PlasalidConfig> = {};
  for (const key of CONFIG_KEYS) {
    if (obj[key] !== undefined) (out as Record<string, unknown>)[key] = obj[key];
  }
  return out;
}

function buildConfig(): PlasalidConfig {
  const file = loadFileConfig();
  // Precedence: env > file > default. Env is checked first so a shell-exported
  // override always wins over whatever is in ~/.plasalid/config.json.
  return {
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
  };
}

export const config = buildConfig();

export function saveConfig(partial: Partial<PlasalidConfig>): void {
  const configPath = getConfigPath();
  if (!existsSync(PLASALID_DIR)) mkdirSync(PLASALID_DIR, { recursive: true });

  const existing = loadFileConfig();
  // Merge onto the existing file, then strip to the surviving keys so any
  // legacy provider fields still on disk are dropped by this write.
  const merged = pickConfigFields({ ...existing, ...partial });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {}

  Object.assign(config, merged);
}
