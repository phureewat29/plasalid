import {
  ALL_THAI_INSTITUTIONS,
  SUGGESTED_ASSET_SUBTYPES,
  SUGGESTED_LIABILITY_SUBTYPES,
  SUGGESTED_EXPENSE_SUBTYPES,
  SUGGESTED_INCOME_SUBTYPES,
} from "../accounts/taxonomy.js";

/**
 * Stringified **Thai** taxonomy block for the scan/reconcile system prompts.
 * Listing known Thai institutions inline gives the model anchors for
 * `bank_name` normalization. Subtype hints help the model pick a consistent
 * `subtype`. Plasalid is currently Thailand-focused; if/when we expand to
 * other locales this helper splits into per-locale variants.
 */
export function getThaiTaxonomyHint(): string {
  const institutions = ALL_THAI_INSTITUTIONS
    .map(i => `${i.code} (${i.label}, ${i.kind})${i.notes ? ` — ${i.notes}` : ""}`)
    .join("\n");
  return [
    `Known Thai institutions:`,
    institutions,
    ``,
    `Suggested asset subtypes: ${SUGGESTED_ASSET_SUBTYPES.join(", ")}`,
    `Suggested liability subtypes: ${SUGGESTED_LIABILITY_SUBTYPES.join(", ")}`,
    `Suggested expense subtypes: ${SUGGESTED_EXPENSE_SUBTYPES.join(", ")}`,
    `Suggested income subtypes: ${SUGGESTED_INCOME_SUBTYPES.join(", ")}`,
  ].join("\n");
}
