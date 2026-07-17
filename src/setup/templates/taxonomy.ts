import {
  ALL_THAI_INSTITUTIONS,
  ACCOUNT_TYPE_DESCRIPTIONS,
  SUGGESTED_ASSET_SUBTYPES,
  SUGGESTED_LIABILITY_SUBTYPES,
  SUGGESTED_EXPENSE_SUBTYPES,
  SUGGESTED_INCOME_SUBTYPES,
  type AccountType,
} from "../../accounts/taxonomy.js";

// references/taxonomy.md (rendered from the live registry)

const KIND_LABELS: { kind: string; heading: string }[] = [
  { kind: "bank", heading: "Banks" },
  { kind: "card_issuer", heading: "Card issuers" },
  { kind: "wallet", heading: "E-wallets" },
  { kind: "payment_rail", heading: "Payment rails" },
  { kind: "broker", heading: "Brokers" },
  { kind: "crypto_exchange", heading: "Crypto exchanges" },
  { kind: "insurer", heading: "Insurers" },
  { kind: "gov", heading: "Government" },
  { kind: "telco", heading: "Telcos" },
  { kind: "utility", heading: "Utilities" },
];

const ACCOUNT_SUBTYPES: { type: AccountType; subtypes: readonly string[] }[] = [
  { type: "asset", subtypes: SUGGESTED_ASSET_SUBTYPES },
  { type: "liability", subtypes: SUGGESTED_LIABILITY_SUBTYPES },
  { type: "income", subtypes: SUGGESTED_INCOME_SUBTYPES },
  { type: "expense", subtypes: SUGGESTED_EXPENSE_SUBTYPES },
  { type: "equity", subtypes: [] },
];

/**
 * Render references/taxonomy.md from the live exports in accounts/taxonomy.ts, so
 * the installed skill always reflects the registry the harness actually uses
 * (rather than a frozen copy that drifts).
 */
export function renderTaxonomyMd(): string {
  const lines: string[] = [];
  lines.push("# plasalid taxonomy");
  lines.push("");
  lines.push(
    "Reference data for categorizing Thai statements. Institution `code`s are stable handles; use them in account names/metadata (e.g. `asset:bank:kbank`, `liability:credit_card:ktc`).",
  );
  lines.push("");

  lines.push("## Account roots and suggested subtypes");
  lines.push("");
  lines.push("The five double-entry roots. Build colon-paths under them.");
  lines.push("");
  for (const { type, subtypes } of ACCOUNT_SUBTYPES) {
    const desc = ACCOUNT_TYPE_DESCRIPTIONS[type];
    lines.push(`- **${type}** — ${desc}`);
    if (subtypes.length) {
      lines.push(`  - suggested subtypes: ${subtypes.map((s) => "`" + s + "`").join(", ")}`);
    }
  }
  lines.push("");

  lines.push("## Thai institution registry");
  lines.push("");
  for (const { kind, heading } of KIND_LABELS) {
    const rows = ALL_THAI_INSTITUTIONS.filter((i) => i.kind === kind);
    if (!rows.length) continue;
    lines.push(`### ${heading}`);
    lines.push("");
    lines.push("| code | institution | notes |");
    lines.push("|---|---|---|");
    for (const inst of rows) {
      const notes = inst.notes ? inst.notes.replace(/\|/g, "\\|") : "";
      lines.push(`| \`${inst.code}\` | ${inst.label} | ${notes} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
