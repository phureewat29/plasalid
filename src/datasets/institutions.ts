import * as z from "zod";
import { loadDatasetRows, type DatasetDefinition } from "./loader.js";

/**
 * The institutions dataset: known financial institutions, one `<cc>.json` file
 * per country under `datasets/institutions/`. The generic loader (loader.ts)
 * handles file walking, validation, and memoization; this module owns the
 * institution shape and the typed finders.
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

/** Shape of one `datasets/institutions/<cc>.json` file. Exported so the loader
 *  test can exercise validation directly without writing a malformed file to disk. */
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

export const institutionsDataset: DatasetDefinition<z.infer<typeof countryFileSchema>> = {
  dirname: "institutions",
  schema: countryFileSchema,
  flatten: (file) => file.institutions,
  sortKey: (row) => String(row.code ?? ""),
  kinds: INSTITUTION_KINDS,
};

function all(): LoadedInstitution[] {
  return loadDatasetRows("institutions", institutionsDataset) as unknown as LoadedInstitution[];
}

/** Every known institution across all countries, sorted by country then code. */
export function getInstitutions(): LoadedInstitution[] {
  return all().slice();
}

/** Institutions filtered by country (case-insensitive) and/or kind. */
export function findInstitutions(
  filter: { country?: string; kind?: string } = {},
): LoadedInstitution[] {
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return all().filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}
