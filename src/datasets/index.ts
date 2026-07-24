import { loadDatasetRows, type DatasetDefinition, type DatasetRow } from "./loader.js";
import { institutionsDataset } from "./institutions.js";
import { defaultsDataset } from "./defaults.js";

/**
 * Public surface of the reference-data module. The registry maps a dataset name
 * to its definition; `listDatasets`/`readDataset` are the generic access path
 * external agents reach through the `datasets` CLI noun. Typed finders
 * (`findInstitutions`, `findCountryDefaults`) live in their own modules and are
 * re-exported here.
 */

// `any` for the file-shape parameter: the registry holds heterogeneous dataset
// definitions (institutions files vs defaults files), and each was authored with
// its own concrete `DatasetDefinition<...>` annotation, so this only erases the
// per-entry file shape the generic loader doesn't need at the registry level.
const REGISTRY: Record<string, DatasetDefinition<any>> = {
  institutions: institutionsDataset,
  defaults: defaultsDataset,
};

/** Names of the shipped datasets (no file I/O). */
export function listDatasetNames(): string[] {
  return Object.keys(REGISTRY);
}

/** Whether a dataset's rows carry a `kind` field (drives the CLI `--kind` guard). */
export function datasetHasKinds(name: string): boolean {
  return !!REGISTRY[name]?.kinds;
}

export interface DatasetSummary {
  name: string;
  countries: string[];
  rows: number;
}

/** One summary row per dataset: name, the countries it covers, and its row count. */
export function listDatasets(): DatasetSummary[] {
  return Object.entries(REGISTRY).map(([name, def]) => {
    const rows = loadDatasetRows(name, def);
    const countries = [...new Set(rows.map((r) => r.country))].sort();
    return { name, countries, rows: rows.length };
  });
}

/** Rows of one dataset, filtered by country (case-insensitive) and/or kind.
 *  Throws on an unknown name — the CLI validates the name first for a clean error. */
export function readDataset(
  name: string,
  filter: { country?: string; kind?: string } = {},
): DatasetRow[] {
  const def = REGISTRY[name];
  if (!def) throw new Error(`unknown dataset "${name}"`);
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return loadDatasetRows(name, def).filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}

export { findInstitutions, getInstitutions } from "./institutions.js";
export type { LoadedInstitution, Institution, InstitutionKind } from "./institutions.js";
export { findCountryDefaults, availableCountries } from "./defaults.js";
export type { CountryDefaults } from "./defaults.js";
export type { DatasetRow } from "./loader.js";
