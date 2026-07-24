import * as z from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Data-driven institution registry. The taxonomy itself lives as one JSON file
 * per country under `taxonomy/` at the package root (shipped via package.json's
 * `files`); this module loads, validates, and flattens those files. Adding a
 * country is a new `<cc>.json`, not a code change.
 */

const INSTITUTION_KINDS = [
  "bank",
  "card_issuer",
  "wallet",
  "payment_rail",
  "broker",
  "crypto_exchange",
  "insurer",
  "gov",
  "telco",
  "utility",
] as const;

const institutionSchema = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(INSTITUTION_KINDS),
  notes: z.string().optional(),
});

/** Shape of one `taxonomy/<cc>.json` file. Exported so the loader test can
 *  exercise validation directly without writing a malformed file to disk. */
export const countryFileSchema = z.object({
  country: z.string(),
  institutions: z.array(institutionSchema),
});

export type InstitutionKind = z.infer<typeof institutionSchema>["kind"];
export type Institution = z.infer<typeof institutionSchema>;

/** An institution tagged with the (uppercased) country it was loaded from. */
export interface LoadedInstitution extends Institution {
  country: string;
}

// Two levels below the package root in both layouts: src/accounts/ under tsx,
// dist/accounts/ once built. `taxonomy/` sits at the root and is not compiled,
// so the same relative walk reaches it in dev, in the build, and in the package.
const TAXONOMY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../taxonomy");

let cache: LoadedInstitution[] | null = null;

function readCountryFile(file: string): LoadedInstitution[] {
  const path = resolve(TAXONOMY_DIR, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // A shipped taxonomy file that won't parse is a packaging defect, not user
    // input — surface it loudly rather than degrading to an empty registry.
    throw new Error(`taxonomy file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = countryFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`taxonomy file ${file} has an invalid shape: ${detail}`);
  }
  const country = parsed.data.country.toUpperCase();
  return parsed.data.institutions.map((inst) => ({ ...inst, country }));
}

/** Read + validate every `taxonomy/*.json`, flatten, and sort stably by
 *  country then code. Runs once; the result is memoized. */
function loadAll(): LoadedInstitution[] {
  const files = readdirSync(TAXONOMY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rows = files.flatMap(readCountryFile);
  rows.sort((a, b) => a.country.localeCompare(b.country) || a.code.localeCompare(b.code));
  return rows;
}

// Lazy + memoized so importing this module does no file I/O; the first
// getInstitutions/findInstitutions call builds the registry once.
function getAll(): LoadedInstitution[] {
  if (!cache) cache = loadAll();
  return cache;
}

/** Every known institution across all countries, sorted by country then code. */
export function getInstitutions(): LoadedInstitution[] {
  return getAll().slice();
}

/** Institutions filtered by country (case-insensitive) and/or kind. */
export function findInstitutions(
  filter: { country?: string; kind?: string } = {},
): LoadedInstitution[] {
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return getAll().filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}
