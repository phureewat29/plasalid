import * as z from "zod";
import { loadDatasetRows, type DatasetDefinition } from "./loader.js";

/**
 * The country-defaults dataset: locale + currency per country, one `<cc>.json`
 * file under `datasets/defaults/`. Each file is a single row, so `config`
 * converge can seed sensible display defaults for a chosen country.
 */

export const countryDefaultsSchema = z.object({
  country: z.string(),
  locale: z.string(),
  currency: z.string(),
});

export interface CountryDefaults {
  country: string;
  locale: string;
  currency: string;
}

export const defaultsDataset: DatasetDefinition<z.infer<typeof countryDefaultsSchema>> = {
  dirname: "defaults",
  schema: countryDefaultsSchema,
  // The file's `country` is re-added by the loader (uppercased); the row carries
  // only the display fields here to avoid duplicating it.
  flatten: (file) => [{ locale: file.locale, currency: file.currency }],
  sortKey: (row) => row.country,
};

function all(): CountryDefaults[] {
  return loadDatasetRows("defaults", defaultsDataset) as unknown as CountryDefaults[];
}

/** The locale/currency defaults for a country (case-insensitive), or null. */
export function findCountryDefaults(country: string): CountryDefaults | null {
  const cc = country.toUpperCase();
  return all().find((r) => r.country === cc) ?? null;
}

/** Uppercased country codes that have defaults, sorted — for "unknown country" hints. */
export function availableCountries(): string[] {
  return all().map((r) => r.country);
}
