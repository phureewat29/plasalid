import * as z from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generic loader for the shipped reference datasets. Each dataset is one
 * subdirectory under `datasets/` at the package root, holding one JSON file per
 * country (`<cc>.json`). This module reads, validates, flattens, and memoizes
 * those files; adding a country is a new file, not a code change. Dataset-specific
 * shape lives in the per-dataset modules (institutions.ts, defaults.ts), each of
 * which describes itself with a `DatasetDefinition`.
 */

// Two levels below the package root in both layouts: src/datasets/ under tsx,
// dist/datasets/ once built. `datasets/` sits at the root and is not compiled,
// so the same relative walk reaches it in dev, in the build, and in the package.
const DATASETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../datasets");

/** A flattened dataset row, always tagged with the (uppercased) country it loaded from. */
export type DatasetRow = Record<string, unknown> & { country: string };

/**
 * Describes one dataset for the generic loader. `schema` validates a single
 * `<cc>.json` file (its `country` field is read to tag rows); `flatten` turns a
 * validated file into its base rows (the loader adds `country`); `sortKey` is the
 * within-country tiebreak; `kinds` (when present) lists the values the dataset's
 * `kind` field can take, which the CLI uses to police a `--kind` filter.
 */
export interface DatasetDefinition<F extends { country: string } = { country: string }> {
  dirname: string;
  schema: z.ZodType<F>;
  flatten: (file: F) => Record<string, unknown>[];
  sortKey?: (row: DatasetRow) => string;
  kinds?: readonly string[];
}

// Memoized per dataset name so importing a dataset module does no file I/O; the
// first read builds that dataset's rows once.
const cache = new Map<string, DatasetRow[]>();

function readCountryFile<F extends { country: string }>(
  def: DatasetDefinition<F>,
  file: string,
): DatasetRow[] {
  const path = resolve(DATASETS_DIR, def.dirname, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // A shipped dataset file that won't parse is a packaging defect, not user
    // input — surface it loudly rather than degrading to an empty registry.
    throw new Error(`dataset file ${def.dirname}/${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`dataset file ${def.dirname}/${file} has an invalid shape: ${detail}`);
  }
  const country = parsed.data.country.toUpperCase();
  return def.flatten(parsed.data).map((row) => ({ ...row, country }));
}

/** Read + validate every `<dataset>/*.json`, flatten, and sort stably by
 *  country then the dataset's `sortKey`. Runs once per dataset; memoized. */
function loadAll<F extends { country: string }>(def: DatasetDefinition<F>): DatasetRow[] {
  const dir = resolve(DATASETS_DIR, def.dirname);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rows = files.flatMap((f) => readCountryFile(def, f));
  rows.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      (def.sortKey ? def.sortKey(a).localeCompare(def.sortKey(b)) : 0),
  );
  return rows;
}

/**
 * Every row of a named dataset, sorted by country then the dataset's sort key.
 * Returns the shared memoized array — callers must copy (slice/filter) before
 * handing it out, which every finder in this module already does.
 */
export function loadDatasetRows<F extends { country: string }>(
  name: string,
  def: DatasetDefinition<F>,
): DatasetRow[] {
  const cached = cache.get(name);
  if (cached) return cached;
  const rows = loadAll(def);
  cache.set(name, rows);
  return rows;
}
