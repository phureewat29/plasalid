// codex block markers

/** Opening marker prefix. The version is appended, so a re-install with a new
 *  version still matches the BEGIN..END span for in-place replacement. */
export const CODEX_BEGIN_MARKER = "<!-- BEGIN plasalid-skill";
export const CODEX_END_MARKER = "<!-- END plasalid-skill -->";

/** Matches a whole previously-installed block (any version) so the installer can
 *  replace it in place instead of appending a duplicate. */
export const CODEX_BLOCK_RE = /<!-- BEGIN plasalid-skill[\s\S]*?<!-- END plasalid-skill -->/;

// AGENTS.md block (codex)

/** Condensed skill wrapped in replace-in-place markers for codex AGENTS.md. */
export function AGENTS_MD_BLOCK(version: string): string {
  return `${CODEX_BEGIN_MARKER} v${version} -->
## plasalid (finance harness)

\`plasalid\` is a deterministic CLI over a local double-entry ledger; you supply the intelligence.

- **Always pass \`--json\`** (NDJSON out; streams end with a \`{"type":"summary"}\` line). Orient with \`plasalid status --json\` first.
- **Never invent ids.** Find them via \`accounts match\`, \`merchants resolve\`, or a \`list\`. File ids are \`sf:...\`, transactions \`tx:...\`, questions \`cn:...\`, merchants \`m:...\`.
- **No prompts.** Destructive ops need \`--yes\`; passwords via \`--password-stdin\` or the vault.
- **Exit codes:** 0 ok · 1 error · 2 usage · 3 not-ready · 4 need password/\`--yes\` (ask the human, retry) · 5 wrong id (list to find it) · 6 invalid input · 7 batch partial (inspect results + questions; duplicates are NOT failures). Errors are \`{"error":{code,message,hint}}\` on stderr. Full flags and subcommands: \`plasalid <noun> --help\`.
- **When blocked (environment, not the harness):** cannot Read the PDF -> \`ingest prepare <sf:id> --format png --dpi 200 --json\` and Read the page PNGs (bundled rasterizer, no system deps). Cannot stage the \`--input\` batch -> write it in the cwd; if Write stays blocked, ask the human; only as a last resort \`transactions add --resolve\` per row (and warn that this loses idempotency + source-file linkage). Run ONE \`plasalid\` command per shell call — no \`&&\`/\`;\`/\`echo\` chaining, no heredoc JSON.
- **Double-entry (transactions):** every entry is one transaction — debit exactly one account, credit exactly one account, single positive amount (direction is WHICH account, never a sign). Normal balances: \`asset\`/\`expense\` up on debit; \`liability\`/\`income\`/\`equity\` up on credit. Card purchase = debit \`expense:<cat>\` / credit \`liability:credit_card:<x>\`; bank spend = debit \`expense:<cat>\` / credit \`asset:bank:<x>\`; salary = debit \`asset:bank:<x>\` / credit \`income:salary\`; a refund or card payment flips the card side (full direction table in SKILL.md). Splits (payslip, loan payment, FX) are a compound \`linked:[...]\` sharing one group. A cross-currency move is a linked conversion pair through \`equity:conversion:<ccy>\`, never one transaction. Accounts are colon-paths under \`asset|liability|income|expense|equity\`. Amounts decimal THB; dates ISO (Thai Buddhist-Era years minus 543).

**Ingest:** \`ingest list\` -> \`ingest prepare <id>\` (accepts the \`path\`/\`rel_path\` or the \`sf:\` id from any cwd; exit 4 -> ask for password, retry \`--password-stdin\`) -> Read the returned \`document\` PDF directly (or \`ingest prepare <sf:id> --format png --dpi 200\` and Read the PNGs if you cannot Read PDFs) -> build NDJSON transaction items in a file -> \`ingest commit --file <sf:id> --input <path>\` -> \`questions list --batch <batch_id>\` -> \`ingest done <id> --agent codex\`. Each item is \`{date, description, debit_account, credit_account, amount, ...}\` (or a compound \`linked:[...]\`); the account ids are hints (exact -> fuzzy -> placeholder -> uncategorized). Number each row with \`row_index\` (0-based, per page) + \`source_page\` and pass \`--file <sf:id>\` so re-ingest is an idempotent no-op (\`duplicate:true\`). Always send \`raw_descriptor\` + \`merchant:{canonical_name,alias}\`. When the statement header implies opening balances, post them per the direction table (\`equity:opening-balance\`) and report what you posted — do not ask first; persist card metadata with \`accounts update <liability:credit_card:x> --masked <digits> ...\` (masked numbers keep their literal trailing digits).

**Clarify:** \`questions list\`; similar_accounts -> \`accounts merge\`; uncategorized -> \`transactions recategorize\` + \`merchants set-default\`; unknown_merchant -> \`merchants upsert\`; currency_mismatch -> re-post as a linked conversion pair; answer with \`questions answer <id> --answer ...\` (\`--also\` for siblings), or \`questions defer\`. Durable prefs/rules: \`notes add --content ... --category preference\` (check \`notes list\` first).

**Report:** net worth via \`plasalid status --json\` (\`net_worth\` block); \`report --from --to\`, \`accounts tree\`, \`transactions list\`, \`transactions dedupe\`.

If a fuller skill is installed at \`.claude/skills/plasalid/SKILL.md\`, read it for workflows; exact flags come from \`plasalid <noun> --help\`.
${CODEX_END_MARKER}`;
}
