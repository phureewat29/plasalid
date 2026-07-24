import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { createHash } from "crypto";
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

const PLASALID_DIR = process.env.PLASALID_DIR
  ? resolve(process.env.PLASALID_DIR)
  : resolve(homedir(), ".plasalid");

/**
 * Drives both field resolution and the persisted-key list: `envVar` (when
 * present) is checked before the file value. Unknown keys on disk are
 * tolerated on read and dropped on the next write — saveConfig writes only
 * the fields listed here.
 */
const CONFIG_FIELDS: Record<keyof PlasalidConfig, { envVar?: string; default: string }> = {
  // Single last-resort locale/currency constants for the whole codebase,
  // overridden by `config converge`. Every other module reads the resolved
  // config value (or getDisplayCurrency) rather than hardcoding a currency.
  // A later wave seeds these from the active dataset.
  displayLocale: { default: "th-TH" },
  displayCurrency: { default: "THB" },
  dbPath: { envVar: "PLASALID_DB_PATH", default: resolve(PLASALID_DIR, "db.sqlite") },
  dbEncryptionKey: { envVar: "PLASALID_DB_ENCRYPTION_KEY", default: "" },
  dataDir: { envVar: "PLASALID_DATA_DIR", default: resolve(PLASALID_DIR, "data") },
  userName: { default: "User" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof PlasalidConfig)[];

export function getPlasalidDir(): string {
  return PLASALID_DIR;
}

export function getConfigPath(): string {
  return resolve(PLASALID_DIR, "config.json");
}

export function getDataDir(): string {
  return config.dataDir;
}

/** Scratch space for decrypted/rasterized artifacts; env-overridable for tests. */
export function getCacheDir(): string {
  return process.env.PLASALID_CACHE_DIR || resolve(PLASALID_DIR, "cache");
}

/** Non-reversible fingerprint (`sha256:` + first 8 hex) so `config`/`status`
 *  can prove a key is set without ever printing the passphrase. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function loadFileConfig(): Partial<PlasalidConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Intentional swallow: this runs at module load (via buildConfig) and from
    // saveConfig. A corrupt config file must degrade to defaults rather than
    // throw — otherwise every command, including the `config` commands that
    // would repair it, would crash on startup.
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
  const out = {} as PlasalidConfig;
  // Precedence env > file > default. `||` (not `??`) so an empty-string value falls through too.
  for (const key of CONFIG_KEYS) {
    const { envVar, default: fallback } = CONFIG_FIELDS[key];
    out[key] = (envVar && process.env[envVar]) || file[key] || fallback;
  }
  return out;
}

export const config = buildConfig();

export function saveConfig(partial: Partial<PlasalidConfig>): void {
  const configPath = getConfigPath();
  if (!existsSync(PLASALID_DIR)) mkdirSync(PLASALID_DIR, { recursive: true });

  const existing = loadFileConfig();
  const merged = pickConfigFields({ ...existing, ...partial });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {}

  Object.assign(config, merged);
}
