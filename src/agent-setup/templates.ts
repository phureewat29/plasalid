/**
 * Skill-pack content, authored as exported TypeScript string constants so it
 * compiles straight into dist/ — there is no copy step and no runtime file read
 * of source markdown. `installSkillPack` (install.ts) writes these strings to the
 * target skill directory / AGENTS.md.
 *
 * Authoring note: every doc is a template literal, so all backticks are escaped
 * as \` and no literal `${` appears in prose (the only interpolation is the
 * injected version). Prose deliberately avoids apostrophes-as-quotes where it is
 * cheap to do so; it keeps the imperative, agent-facing voice terse.
 */

import {
  ALL_THAI_INSTITUTIONS,
  ACCOUNT_TYPE_DESCRIPTIONS,
  SUGGESTED_ASSET_SUBTYPES,
  SUGGESTED_LIABILITY_SUBTYPES,
  SUGGESTED_EXPENSE_SUBTYPES,
  SUGGESTED_INCOME_SUBTYPES,
  type AccountType,
} from "../accounts/taxonomy.js";

// --- codex block markers ---------------------------------------------------

/** Opening marker prefix. The version is appended, so a re-install with a new
 *  version still matches the BEGIN..END span for in-place replacement. */
export const CODEX_BEGIN_MARKER = "<!-- BEGIN plasalid-skill";
export const CODEX_END_MARKER = "<!-- END plasalid-skill -->";

/** Matches a whole previously-installed block (any version) so the installer can
 *  replace it in place instead of appending a duplicate. */
export const CODEX_BLOCK_RE = /<!-- BEGIN plasalid-skill[\s\S]*?<!-- END plasalid-skill -->/;

// --- SKILL.md (Claude Code) ------------------------------------------------

/** The main agent-facing skill file. Kept focused; deep detail lives in
 *  references/{commands,schemas,taxonomy}.md. */
export function SKILL_MD(version: string): string {
  return `---
name: plasalid
description: Drive plasalid, a local double-entry personal-finance harness, from the command line. Use for anything about the user's ledger, bank/credit-card statements, Thai bank PDFs, net worth, spending, budgets, accounts, transactions, merchants, or when the user names plasalid. Ingest statement PDFs, extract transactions, categorize accounts, resolve merchants, clear clarifying questions, and run net-worth / period reports.
version: ${version}
---

# plasalid

You are driving \`plasalid\`, a deterministic CLI harness over a local double-entry ledger. The harness has no AI loop of its own — you are the intelligence. Every command is scriptable and non-interactive.

## 1. Golden rules

- **Always pass \`--json\`.** Output becomes NDJSON: one object per line, and streaming commands close with a \`{"type":"summary",...}\` line. Never scrape the human tables.
- **Orient first.** Run \`plasalid status --json\` before acting — it reports config, database, ledger counts, and net worth.
- **Never invent ids.** Account paths, merchant ids, file ids (\`sf:...\`), transaction ids (\`tx:...\`), and question ids (\`cn:...\`) all come from the harness. Discover them with \`accounts match\`, \`merchants resolve\`, or a \`list\` before you use one.
- **The harness never prompts.** Destructive commands need \`--yes\`. Passwords arrive via \`--password-stdin\` or the vault. There is no stdin prompt to wait on.
- **Branch on the exit code, not on stderr prose:**

| code | meaning | reaction |
|---|---|---|
| 0 | ok | continue |
| 2 | usage | fix the command line |
| 3 | not ready | db/config not ready — run \`plasalid doctor --json\` |
| 4 | input required | password or \`--yes\` missing — ask the human, then retry |
| 5 | not found | an id was wrong — \`list\`/\`match\` to find the real one |
| 6 | invalid | bad input — fix and resend |
| 7 | partial | batch partly failed — inspect each \`result\` and the raised questions |

Errors print one object on stderr: \`{"error":{"code":"E_...","message":...,"hint":...}}\`. Always read \`hint\`.

## 2. Core concepts

- **Double-entry.** A transaction is a set of postings that balance. Assets and expenses are debit-normal; liabilities, income, and equity are credit-normal. If postings do not balance, the harness auto-plugs the difference onto \`equity:adjustments\` — never hand-add that plug yourself.
- **Accounts** are colon-paths under five roots: \`asset\`, \`liability\`, \`income\`, \`expense\`, \`equity\` (e.g. \`expense:food:groceries\`). Run \`accounts match --query <name> --json\` to reuse an existing account before \`accounts create\`.
- **Amounts** are decimal, THB by default. **Dates** are ISO \`YYYY-MM-DD\`. Thai statements often print Buddhist-Era years — subtract 543 (2568 becomes 2025).
- **Merchants.** When committing, always send \`raw_descriptor\` plus \`merchant:{canonical_name, alias}\` so the harness learns the alias and auto-resolves it next time.
- **account_id in ingest postings is a HINT.** The harness resolves each one: exact match, then fuzzy match (score >= 0.7), then a new placeholder account, then \`expense:uncategorized\`. It never blocks — it commits and raises a question you resolve later.

## 3. Workflow: ingest statements

1. \`plasalid ingest list --json\` — every PDF in the data dir with its status (\`new\`/\`pending\`/\`scanned\`/\`failed\`), \`file_id\`, and whether it is encrypted.
2. For each new/pending file: \`plasalid ingest prepare <pathOrId> --json\`. This registers and unlocks the PDF and exports page PNGs to a cache dir; the result lists their paths.
   - Exit 4 means encrypted and locked. Ask the human for the password, then retry: \`printf '%s' "$PW" | plasalid ingest prepare <id> --password-stdin --json\`. Offer to persist it: \`plasalid vault add <pattern> --password-stdin\`.
3. **Read the exported PNG pages** — they are image files; view them.
4. Extract every transaction. Build one NDJSON object per transaction (schema in section 7).
5. Commit: \`... | plasalid ingest commit --file <sf:id> --json\`. Each input line returns a \`result\`; the final \`summary\` carries the \`batch_id\`. Exit 7 means some rows failed — inspect each \`result\`.
6. \`plasalid questions list --batch <batch_id> --json\` — resolve with the human or defer (section 4).
7. \`plasalid ingest done <sf:id> --agent claude-code --json\`. (On unrecoverable failure: \`plasalid ingest fail <sf:id> --error "<why>" --json\`.)

## 4. Workflow: clear the question backlog

\`plasalid questions list --json\`, then handle by \`kind\`:
- **similar_accounts** — the scanner saw a near-duplicate account. If they are truly the same: \`plasalid accounts merge --from <id> --to <id> --yes --json\`.
- **uncategorized** (a placeholder was created) — pick the real account, then reclassify: \`plasalid tx recategorize --set-account <id> --filter-account <placeholder> --json\`, and make it stick: \`plasalid merchants set-default --merchant <id> --account <id> --json\`.
- **unknown_merchant** — link it with \`plasalid merchants upsert --name <canonical> --alias <descriptor> --json\`.
- Answer with \`plasalid questions answer <id> --answer "<text>" --json\`; use \`--also <id,id>\` to close siblings at once. Use \`plasalid questions defer <id> --days <n> --json\` when it is currently unknowable.

## 5. Workflow: record a natural-language expense

Example: "300 baht lunch, cash".
1. Find real ids: \`plasalid accounts match --query cash --json\` and \`... --query food --json\` (create with \`accounts create\` if missing).
2. \`plasalid tx add --json\` with two balancing postings (debit \`expense:food\` 300, credit \`asset:cash\` 300). Pass \`--resolve\` to let the harness fuzzy-resolve hint ids and raise questions instead of failing on an unknown id.

## 6. Workflow: reporting

- \`plasalid report net-worth --json\` — assets, liabilities, net worth.
- \`plasalid report period --from <date> --to <date> --json\` — income/expenses/net over a range.
- \`plasalid accounts tree --json\`; \`plasalid postings list --json\` / \`plasalid postings search --query <text> --json\`.
- \`plasalid analyze duplicates --json\` (add \`--auto-merge\`); \`plasalid analyze correlations --json\`.

## 7. Cheat sheet + ingest schema

\`status\` · \`doctor\` · \`setup\` · \`config show|set\` · \`ingest list|prepare|commit|done|fail|clean\` · \`files list|show|drop\` · \`vault add|list|rm|test\` · \`tx add|show|update|delete|recategorize\` · \`postings list|search|update\` · \`accounts list|tree|show|create|rename|merge|delete|adjust|match|similar|metadata\` · \`merchants list|resolve|upsert|set-default|clear-default\` · \`questions list|answer|defer\` · \`report net-worth|period\` · \`analyze duplicates|correlations\` · \`notes\` · \`taxonomy\` · \`context show|path\`

One ingest transaction (NDJSON — one object per line, piped to \`ingest commit\`):

\`\`\`json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"postings":[{"account_id":"expense:food:coffee","debit":135.00,"currency":"THB"},{"account_id":"asset:bank:kbank","credit":135.00,"currency":"THB"}]}
\`\`\`

- \`date\`, \`description\`, and \`postings\` (>= 1) are required. Each posting needs \`account_id\` plus exactly one of \`debit\`/\`credit\` (> 0). Postings need not balance — the harness plugs the remainder to \`equity:adjustments\`.
- \`account_id\` is a hint (see section 2). \`currency\` defaults to \`THB\`.
- Send \`raw_descriptor\` + \`merchant\` so aliases are learned.

More detail: the full input/result/question/error schemas and exit codes are in \`references/schemas.md\`; every command and flag in \`references/commands.md\`; the Thai institution registry in \`references/taxonomy.md\`.
`;
}

// --- references/commands.md ------------------------------------------------

export const COMMANDS_REFERENCE_MD = `# plasalid command reference

Every command accepts the global flags below. \`--json\` is strongly recommended
for agents. Ids are opaque strings minted by the harness — never fabricate them.

## Global flags (accepted before or after any subcommand)

- \`--json\` — emit NDJSON instead of human tables.
- \`--no-color\` — disable ANSI color.
- \`--quiet\` — suppress non-essential output.

Destructive commands additionally require \`--yes\`. Secrets are read from stdin
(\`--password-stdin\`, \`--encryption-key-stdin\`); they are never passed as flags.

## Orientation

- \`plasalid status [--redact]\` — config, db, ledger counts, net worth. Also the no-arg default (\`plasalid\`).
- \`plasalid doctor\` — environment checks; exit 3 when a hard check fails.
- \`plasalid setup [--data-dir <dir>] [--db <path>] [--generate-key | --encryption-key-stdin] [--locale <l>] [--currency <c>] [--user-name <n>] [--force]\` — headless init.
- \`plasalid config show\` · \`plasalid config set [--data-dir <dir>] [--db <path>] [--locale <l>] [--currency <c>] [--user-name <n>] [--encryption-key-stdin]\` · \`plasalid config path\`.
- \`plasalid context show\` · \`plasalid context path\`.
- \`plasalid taxonomy\` — dump the Thai institution registry as data.

## Ingest pipeline

- \`plasalid ingest list [--regex <pattern>]\` — discover data-dir PDFs vs the db.
- \`plasalid ingest prepare <pathOrId> [--password-stdin] [--force] [--format png|pdf] [--dpi <n>] [--pages "1-5,8"] [--out <dir>]\` — register + unlock + export pages for you to Read. Exit 4 when a password is required.
- \`plasalid ingest commit [--file <sf:id>] [--scan-id <sc:id>]\` — read NDJSON/JSON-array transactions from stdin, post them, mint a batch id, return per-item results + summary. Exit 7 on partial failure.
- \`plasalid ingest done <sf:id> [--agent <name>] [--note <text>]\` — mark scanned (clears the page cache).
- \`plasalid ingest fail <sf:id> --error <text> [--agent <name>]\` — mark failed.
- \`plasalid ingest clean [--file <sf:id>]\` — remove prepared page artifacts.

## Files & vault

- \`plasalid files list [--status new|pending|scanned|failed]\` · \`plasalid files show <sf:id>\` · \`plasalid files drop <sf:id> --yes\` (cascades transactions + questions).
- \`plasalid vault add <pattern> --password-stdin\` · \`plasalid vault list\` · \`plasalid vault rm <patternOrId> --yes\` · \`plasalid vault test <path>\`.

## Transactions & postings

- \`plasalid tx add [--resolve] [--date <d>] [--description <t>] [--amount <n>] [--debit-account <id>] [--credit-account <id>] [--currency <c>] [--merchant-name <n>]\` — strict by default (unknown account ids fail with exit 5); \`--resolve\` fuzzy-resolves and raises questions. Also accepts a JSON transaction on stdin.
- \`plasalid tx show <tx:id> [--redact]\` · \`plasalid tx update <tx:id> [--date <d>] [--description <t>] [--source-page <n>]\` · \`plasalid tx delete <tx:id> --yes\`.
- \`plasalid tx recategorize --set-account <id> [--set-memo <t>] [--filter-account <id>] [--filter-desc <t>] [--filter-merchant <id>] [--filter-currency <c>] [--from <d>] [--to <d>]\` — bulk move postings (account_id + memo only; amounts are immutable).
- \`plasalid postings list [--account <id>] [--from <d>] [--to <d>] [--query <t>] [--limit <n>] [--group] [--redact]\` · \`plasalid postings search --query <t> [--limit <n>] [--redact]\` · \`plasalid postings update <p:id> [--account <id>] [--memo <t>]\`.

## Accounts

- \`plasalid accounts list [--type <t>] [--redact]\` · \`plasalid accounts tree [--type <t>]\` · \`plasalid accounts show <id>\`.
- \`plasalid accounts create --id <id> --name <n> --type <t> [--parent <id>] [--subtype <s>] [--bank <n>] [--masked <num>] [--currency <c>] [--due-day <n>] [--statement-day <n>] [--metadata <json>]\`.
- \`plasalid accounts rename <id> --name <n>\` · \`plasalid accounts merge --from <id> --to <id> --yes\` · \`plasalid accounts delete <id> --yes\`.
- \`plasalid accounts adjust <id> --to <amount> [--reason <t>] [--date <d>]\` — post a balancing adjustment to reach a target balance.
- \`plasalid accounts match --query <t> [--threshold <n>]\` — fuzzy lookup before create. \`plasalid accounts similar [--threshold <n>]\` — find near-duplicate accounts.
- \`plasalid accounts metadata <id> [--due-day <n>] [--statement-day <n>] [--points <n>] [--masked <num>] [--bank <n>] [--metadata <json>]\`.

## Merchants

- \`plasalid merchants list [--with-default-only] [--limit <n>]\` · \`plasalid merchants resolve --descriptor <t>\`.
- \`plasalid merchants upsert --name <canonical> [--alias <a>] [--default-account <id>]\`.
- \`plasalid merchants set-default --merchant <id> --account <id>\` · \`plasalid merchants clear-default --merchant <id>\`.

## Questions, reports, analysis, notes

- \`plasalid questions list [--kind <k>] [--file <sf:id>] [--batch <sc:id>] [--include-deferred] [--limit <n>] [--redact]\`.
- \`plasalid questions answer <cn:id> --answer <t> [--also <id,id>]\` · \`plasalid questions defer <cn:id> [--days <n>]\`.
- \`plasalid report net-worth\` · \`plasalid report period --from <d> --to <d>\`.
- \`plasalid analyze duplicates [--tolerance-days <n>] [--account <id>] [--min-amount <n>] [--auto-merge]\` · \`plasalid analyze correlations [--from <d>] [--to <d>] [--tolerance-days <n>] [--min-amount <n>]\`.
- \`plasalid notes list\` · \`plasalid notes add --content <t> [--category <c>]\` · \`plasalid notes rm <id> --yes\`.
`;

// --- references/schemas.md -------------------------------------------------

export const SCHEMAS_MD = `# plasalid schemas

## Ingest commit input (stdin)

\`plasalid ingest commit\` reads either NDJSON (one object per line) or a single
JSON array. One object = one transaction:

| field | type | required | notes |
|---|---|---|---|
| \`date\` | string | yes | ISO \`YYYY-MM-DD\`. Convert Buddhist-Era years (year - 543). |
| \`description\` | string | yes | Human-readable summary of the row. |
| \`postings\` | array | yes | >= 1 posting (see below). |
| \`raw_descriptor\` | string | no | Verbatim bank text. Drives merchant-alias learning. |
| \`source_page\` | number | no | Page the row came from (informational). |
| \`source_file_id\` | string | no | \`sf:...\` id. Falls back to \`--file\`. |
| \`merchant\` | object | no | \`{canonical_name (required), alias?, default_account_id?}\`. Upserted + alias learned. |
| \`merchant_id\` | string | no | Pre-resolved merchant id. Overrides \`merchant\`. Unknown id raises \`unknown_merchant\`. |

Posting object:

| field | type | required | notes |
|---|---|---|---|
| \`account_id\` | string | yes | HINT only — resolved exact -> fuzzy (>= 0.7) -> placeholder -> \`expense:uncategorized\`. |
| \`debit\` | number | one of | >= 0. A posting has exactly one of debit/credit > 0. |
| \`credit\` | number | one of | >= 0. |
| \`currency\` | string | no | Defaults to \`THB\`. |
| \`memo\` | string | no | Per-posting note. |

Postings need not balance: any imbalance is auto-plugged to \`equity:adjustments\`.
Do not add that plug yourself.

## Ingest commit output (NDJSON)

Per input item, one \`result\`, then a terminal \`summary\`.

Success:

\`\`\`json
{"type":"result","index":0,"ok":true,"transaction_id":"tx:...","raised_questions":1,"merchant":{"how":"linked","merchant_id":"mrc:..."},"postings":[{"index":0,"requested":"expense:food:coffee","resolved":"expense:food:coffee","how":"exact"}]}
\`\`\`

- \`merchant.how\`: \`none\` (none supplied) | \`unknown\` (id did not exist) | \`linked\` (\`merchant_id\` present).
- posting \`how\`: \`exact\` | \`fuzzy_matched\` | \`placeholder_created\` | \`uncategorized_fallback\`. \`requested\` is your hint; \`resolved\` is what was actually posted.

Failure (validation): the row is dropped, and a \`dirty_input\` question is raised.

\`\`\`json
{"type":"result","index":1,"ok":false,"reason":"dirty_input","message":"...","raised_questions":1}
\`\`\`

Summary (batch id is the \`scan_id\` questions attach to; exit 7 when \`failed\` > 0):

\`\`\`json
{"type":"summary","batch_id":"sc:...","posted":3,"failed":1,"raised_questions":2}
\`\`\`

## Question row (from \`questions list --json\`)

\`\`\`json
{"id":"cn:...","kind":"uncategorized","prompt":"...","transaction_id":null,"account_id":"expense:...","options":null,"context":{"rule_key":"...","placeholder_id":"expense:..."},"file_id":"sf:...","created_at":"..."}
\`\`\`

\`kind\` is free text; the values the pipeline raises are:

- \`dirty_input\` — a row failed validation and was not posted.
- \`unknown_merchant\` — \`merchant_id\` referenced a missing merchant. \`context\`: \`descriptor\`, \`attempted_id\`.
- \`uncategorized\` — a placeholder account was created. \`context\`: \`placeholder_id\`.
- \`similar_accounts\` — a hint fuzzy-matched an existing account. \`context\`: \`original_id\`, \`matched_id\`.

\`context.rule_key\` (when present) is what answering learns a reusable rule on.

## Error object (stderr)

\`\`\`json
{"error":{"code":"E_INVALID","message":"...","hint":"...","details":{}}}
\`\`\`

\`code\` is \`E_\` + the exit-code name below. \`hint\` and \`details\` are optional.

## Exit codes

| code | name | meaning |
|---|---|---|
| 0 | OK | success |
| 1 | GENERIC | unclassified error |
| 2 | USAGE | bad command line / stdin parse |
| 3 | NOT_READY | db/config not ready |
| 4 | INPUT_REQUIRED | password or \`--yes\` needed |
| 5 | NOT_FOUND | id / entity not found |
| 6 | INVALID | semantically invalid input |
| 7 | PARTIAL | batch partly succeeded |
`;

// --- references/taxonomy.md (rendered from the live registry) ---------------

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

// --- AGENTS.md block (codex) -----------------------------------------------

/** Condensed skill wrapped in replace-in-place markers for codex AGENTS.md. */
export function AGENTS_MD_BLOCK(version: string): string {
  return `${CODEX_BEGIN_MARKER} v${version} -->
## plasalid (finance harness)

\`plasalid\` is a deterministic CLI over a local double-entry ledger; you supply the intelligence.

- **Always pass \`--json\`** (NDJSON out; streams end with a \`{"type":"summary"}\` line). Orient with \`plasalid status --json\` first.
- **Never invent ids.** Find them via \`accounts match\`, \`merchants resolve\`, or a \`list\`. File ids are \`sf:...\`, transactions \`tx:...\`, questions \`cn:...\`.
- **No prompts.** Destructive ops need \`--yes\`; passwords via \`--password-stdin\` or the vault.
- **Exit codes:** 0 ok · 2 usage · 3 not-ready · 4 need password/\`--yes\` (ask the human, retry) · 5 wrong id (list to find it) · 6 invalid input · 7 batch partial (inspect results + questions). Errors are \`{"error":{code,message,hint}}\` on stderr.
- **Double-entry:** postings balance; imbalance auto-plugs to \`equity:adjustments\` (never hand-add it). Accounts are colon-paths under \`asset|liability|income|expense|equity\`. Amounts THB; dates ISO (Thai Buddhist-Era years minus 543).

**Ingest:** \`ingest list\` -> \`ingest prepare <id>\` (exit 4 -> ask for password, retry \`--password-stdin\`) -> Read the exported page PNGs -> build NDJSON transactions -> \`ingest commit --file <sf:id>\` -> \`questions list --batch <batch_id>\` -> \`ingest done <id> --agent codex\`. In postings, \`account_id\` is a hint (exact -> fuzzy -> placeholder -> uncategorized); always send \`raw_descriptor\` + \`merchant:{canonical_name,alias}\`.

**Clarify:** \`questions list\`; similar_accounts -> \`accounts merge\`; uncategorized -> \`tx recategorize\` + \`merchants set-default\`; answer with \`questions answer <id> --answer ...\` (\`--also\` for siblings), or \`questions defer\`.

**Report:** \`report net-worth\`, \`report period --from --to\`, \`accounts tree\`, \`analyze duplicates|correlations\`.

If a fuller skill is installed at \`.claude/skills/plasalid/\`, prefer its \`references/\` docs for exact flags and schemas.
${CODEX_END_MARKER}`;
}
