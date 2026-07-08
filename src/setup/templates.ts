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

// codex block markers

/** Opening marker prefix. The version is appended, so a re-install with a new
 *  version still matches the BEGIN..END span for in-place replacement. */
export const CODEX_BEGIN_MARKER = "<!-- BEGIN plasalid-skill";
export const CODEX_END_MARKER = "<!-- END plasalid-skill -->";

/** Matches a whole previously-installed block (any version) so the installer can
 *  replace it in place instead of appending a duplicate. */
export const CODEX_BLOCK_RE = /<!-- BEGIN plasalid-skill[\s\S]*?<!-- END plasalid-skill -->/;

// SKILL.md (Claude Code)

/** The main agent-facing skill file. Kept focused; deep detail lives in
 *  references/{commands,schemas,taxonomy}.md. */
export function SKILL_MD(version: string): string {
  return `---
name: plasalid
description: Drive plasalid, a local double-entry personal-finance harness, from the command line. Use for anything about the user's ledger, bank/credit-card statements, Thai bank PDFs, net worth, spending, accounts, transactions, merchants, or when the user names plasalid. Ingest statement PDFs, extract transactions, categorize accounts, resolve merchants, clear clarifying questions, and run net-worth / period reports.
version: ${version}
---

# plasalid

You drive \`plasalid\`, a deterministic CLI over a local double-entry ledger — no AI loop of its own, you are the intelligence. Every command is scriptable and non-interactive.

## Golden rules

- **Always pass \`--json\`.** NDJSON out: one object per line; streaming commands end with a \`{"type":"summary",...}\` line. Never scrape human tables.
- **Orient first:** \`plasalid status --json\` (config, database, ledger counts, net worth).
- **Never invent ids.** Account paths and \`sf:\` file / \`tx:\` transaction / \`cn:\` question / \`m:\` merchant ids all come from the harness — find them with \`accounts match\`, \`merchants resolve\`, or a \`list\`.
- **The harness never prompts.** Destructive commands need \`--yes\`; passwords go through \`--password-stdin\` or the vault.
- **Branch on the exit code:** 0 ok · 1 error · 2 usage · 3 not-ready (run \`plasalid doctor --json\`) · 4 input required (password / \`--yes\` — ask the human, retry) · 5 not-found (wrong id — \`list\`/\`match\`) · 6 invalid · 7 partial (batch partly failed — inspect each \`result\`). Full table in \`references/schemas.md\`.
- **Errors** are one stderr object \`{"error":{"code":"E_...","message":...,"hint":...}}\`. Always read \`hint\`.
- **Statement rows go through \`ingest commit --file <sf:id> --input <path>\`, never \`transactions add\` per row.** Batch every row into ONE commit: stage the NDJSON to a file, pass \`--input\`. That links rows to the source file and keeps re-ingest idempotent. \`transactions add\` is only for one-offs with no source document.

## When you are blocked

Degrade in this order when your *environment* fights you — never silently break the rules above.

- **Cannot Read the PDF** (Read tool has no PDF support): \`plasalid ingest prepare <sf:id> --format png --dpi 200 --json\` returns one PNG per page in \`pages\`; Read those. plasalid rasterizes with a bundled engine — no poppler or system dependency to install.
- **File writes blocked** (cannot stage the \`--input\` batch): write it in the current working directory first (usually allowed); if Write stays unavailable, ASK the human to enable it. LAST resort only: commit rows one-by-one with \`plasalid transactions add --resolve\`, then TELL the user this dropped idempotency and source-file linkage, so a re-run double-posts.
- **One \`plasalid\` command per Bash call.** Never chain with \`&&\`/\`;\`/\`echo\`, never heredoc JSON — allowlists and a brace guard block those. Move batches through \`--input <file>\`.

## Core concepts

- **Every entry is a _transaction_:** debits exactly one account, credits exactly one, by a single positive amount. Direction is WHICH account is debit vs credit — never a sign. Amounts are DECIMAL as printed (\`135.00\`); stored as integer minor units.
- **Normal balances:** \`asset\`/\`expense\` increase by a DEBIT; \`liability\`/\`income\`/\`equity\` by a CREDIT. Pick the two sides by which account each half grows.
- **Accounts** are colon-paths under \`asset\`, \`liability\`, \`income\`, \`expense\`, \`equity\` (e.g. \`expense:food:groceries\`). Reuse before creating: \`plasalid accounts match --query <name> --json\`. \`accounts create\` auto-creates missing parents (\`created_parents\` in output) — but \`match\` first to avoid a near-duplicate.

### Direction table

| Situation | Debit account | Credit account |
|---|---|---|
| Card purchase | \`expense:<cat>\` | \`liability:credit_card:<x>\` |
| Bank / debit-card spend | \`expense:<cat>\` | \`asset:bank:<x>\` |
| Bank fee | \`expense:fees\` | \`asset:bank:<x>\` |
| Cash purchase | \`expense:<cat>\` | \`asset:cash\` |
| Salary (net, simple) | \`asset:bank:<x>\` | \`income:salary\` |
| Interest earned | \`asset:bank:<x>\` | \`income:interest\` |
| Refund on card | \`liability:credit_card:<x>\` | \`expense:<cat>\` |
| Card payment (pay card from bank) | \`liability:credit_card:<x>\` | \`asset:bank:<x>\` |
| Cash withdrawal | \`asset:cash\` | \`asset:bank:<x>\` |
| Opening balance (asset) | \`asset:<x>\` | \`equity:opening-balance\` |
| Opening balance (card / liability) | \`equity:opening-balance\` | \`liability:credit_card:<x>\` |

- **Negative statement amounts mean money flowed BACK — never send a negative \`amount\`.** Use the matching table row at the absolute value: a \`-165.00\` card row is a refund; a large negative \`Payment via <app>\` row is the card payment.
- **Card rows print two dates (transaction + posted). Use the TRANSACTION date.**
- **Compound = shared-leg decomposition:** a split line becomes \`linked\` legs that commit atomically under one \`group_id\`. Find the ONE shared account; never invent clearing accounts. Payslip legs share \`income:salary\`; loan-payment legs share the paying \`asset:bank:<x>\`.
- **Idempotency (once, everywhere):** put \`row_index\` (0-based, per page) + \`source_page\` on every item and pass \`--file <sf:id>\`. The harness derives a stable id from file hash + page + row, so re-ingest is a \`duplicate:true\` no-op. Never renumber rows between retries.
- **Currency:** a transaction's two accounts must share one currency (derived from the accounts, never trusted from input). A cross-currency row is dropped as \`currency_mismatch\` — post it as two linked legs, one per currency, through \`equity:conversion:<ccy>\` (example in \`references/schemas.md\`). Thai statements print Buddhist-Era years — subtract 543.
- **Corrections:** wrong category -> \`plasalid transactions recategorize\`; wrong amount/currency -> \`plasalid transactions delete\` then re-ingest that row. A refund is a forward transaction (see table), never an edit.
- **Account ids are HINTS:** each side resolves exact -> fuzzy (>= 0.7) -> placeholder -> \`expense:uncategorized\`, committing and raising a question rather than blocking. Send \`raw_descriptor\` + \`merchant:{canonical_name, alias}\` so aliases are learned.

## Workflow: ingest statements

1. \`plasalid ingest list --json\` — each PDF's status (\`new\`/\`pending\`/\`scanned\`/\`failed\`), \`file_id\`, and whether it is encrypted.
2. \`plasalid ingest prepare <pathOrId> --json\` per new/pending file — \`<pathOrId>\` is the \`path\`/\`rel_path\` from \`ingest list\` or the \`sf:\` id (any cwd); returns \`document\`, the PDF to Read. Exit 4 = locked: get the password from the human, then \`printf '%s' "$PW" | plasalid ingest prepare <id> --password-stdin --json\`; store it with \`plasalid vault add <pattern> --password-stdin\`.
3. **Read the \`document\` PDF** and extract every row. (No PDF support? See **When you are blocked**.)
4. Build one NDJSON item per row (schema below): set \`row_index\` + \`source_page\`; send \`raw_descriptor\` + \`merchant\`.
5. Stage the batch to a file, then \`plasalid ingest commit --file <sf:id> --input <path> --json\`. Each line is a \`result\`; the \`summary\` has \`batch_id\`, \`posted\`, \`duplicates\`, \`failed\`. Exit 7 = some rows failed (a \`duplicate\` is a successful no-op).
6. **Opening balances:** when the header implies a pre-existing balance (prior card balance, account starting balance), POST it per the direction table (\`equity:opening-balance\`) then REPORT what you posted — do not ask first.
7. Card metadata from the header: \`plasalid accounts update <liability:credit_card:x> --masked <digits> --points <n> --due-day <d> --statement-day <d> --json\`. The masked number keeps its literal trailing digits (store \`1234\` as printed).
8. \`plasalid questions list --batch <batch_id> --json\` — resolve or defer (below).
9. \`plasalid ingest done <sf:id> --agent claude-code --json\` (failure: \`plasalid ingest fail <sf:id> --error "<why>" --json\`).

## Workflow: clear questions

\`plasalid questions list --json\`, then by \`kind\`:
- **similar_accounts** — near-duplicate; if the same: \`plasalid accounts merge --from <id> --to <id> --yes --json\`.
- **uncategorized** (placeholder created) — \`plasalid transactions recategorize --set-account <id> --filter-account <placeholder> --json\`, then \`plasalid merchants set-default --merchant <id> --account <id> --json\`.
- **unknown_merchant** — \`plasalid merchants upsert --name <canonical> --alias <descriptor> --json\`.
- **currency_mismatch** — re-post as a linked conversion pair.
- Answer: \`plasalid questions answer <id> --answer "<text>" --json\` (\`--also <id,id>\` closes siblings); \`plasalid questions defer <id> --days <n> --json\` when unknowable.
- Durable user preference/rule? \`plasalid notes add --content "..." --category preference --json\` (check \`plasalid notes list --json\` first).

## Other workflows

- **Manual entry** — a one-off the user dictates ("300 baht lunch, cash"), NOT statement rows: find ids with \`plasalid accounts match --query <name> --json\`, then \`plasalid transactions add --debit-account expense:food --credit-account asset:cash --amount 300 --json\`. Add \`--resolve\` to fuzzy-resolve hint ids and raise questions instead of failing.
- **Reporting** — net worth: \`plasalid status --json\` (\`net_worth\`). Also \`plasalid report period --from <date> --to <date> --json\`; \`plasalid accounts show|tree --json\` (per-account \`balance\`/\`debits_posted\`/\`credits_posted\`, rollups); \`plasalid ledger --json\` (+ \`ledger show <tx:id>\`); \`plasalid analyze duplicates|correlations --json\`.

## Ingest item

One standalone NDJSON item (a compound item swaps the account/amount fields for a \`linked:[...]\` array sharing one group — payslip, loan, FX). Required: \`date\`, \`description\`, \`debit_account\`, \`credit_account\`, \`amount\` (> 0); account ids are HINTS. Field table, compound + FX examples, and result / exit-code schemas: \`references/schemas.md\`; commands + flags: \`references/commands.md\`; Thai institutions: \`references/taxonomy.md\`.

\`\`\`json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
\`\`\`
`;
}

// references/commands.md

export const COMMANDS_REFERENCE_MD = `# plasalid command reference

Every command accepts the global flags below. \`--json\` is strongly recommended
for agents. Ids are opaque strings minted by the harness — never fabricate them.

## Global flags (accepted before or after any subcommand)

- \`--json\` — emit NDJSON instead of human tables.
- \`--no-color\` — disable ANSI color.

Destructive commands additionally require \`--yes\`. Secrets are read from stdin
(\`--password-stdin\`, \`--encryption-key-stdin\`); they are never passed as flags.

## Orientation

- \`plasalid status [--redact]\` — config, db, ledger counts, net worth. Also the no-arg default (\`plasalid\`).
- \`plasalid doctor\` — environment checks; exit 3 when a hard check fails.
- \`plasalid config [--data-dir <dir>] [--db <path>] [--generate-key | --encryption-key-stdin] [--locale <l>] [--currency <c>] [--user-name <n>]\` — idempotent configure/init (first run initializes, later runs update).
- \`plasalid config show\` — print the current configuration (bare \`plasalid config\` with no flags also shows).
- \`plasalid context show\` · \`plasalid context path\`.
- \`plasalid setup [--claude] [--codex] [--global] [--dir <path>] [--force] [--print]\` — install/refresh this skill pack for an agent CLI.
- \`plasalid data\` — open the data folder in the OS file explorer (alias: \`open\`).

## Ingest pipeline

- \`plasalid ingest list [--regex <pattern>]\` — discover data-dir PDFs vs the db.
- \`plasalid ingest prepare <pathOrId> [--password-stdin] [--force] [--out <dir>]\` — register + unlock, returning \`document\` (the statement PDF path) for you to Read. \`<pathOrId>\` is the \`path\`/\`rel_path\` from \`ingest list\` or the \`sf:\` id, resolved from any working directory. Exit 4 when a password is required. When your Read tool has no PDF support, \`plasalid ingest prepare <sf:id> --format png --dpi 200\` rasterizes each page to a PNG (bundled rasterizer, no system dependency); \`dpi\` defaults to 150.
- \`plasalid ingest commit [--file <sf:id>] [--input <path>]\` — read NDJSON/JSON-array transaction items from the \`--input\` file (or stdin), post them, mint a batch id, return per-item results + summary. Exit 7 on partial failure (duplicates are a successful no-op).
- \`plasalid ingest done <sf:id> [--agent <name>]\` — mark scanned (clears the page cache).
- \`plasalid ingest fail <sf:id> --error <text> [--agent <name>]\` — mark failed (also clears the page cache).

## Files & vault

- \`plasalid files list [--status new|pending|scanned|failed]\` · \`plasalid files show <sf:id>\` · \`plasalid files drop <sf:id> --yes\` (cascades transactions + questions).
- \`plasalid vault add <pattern> --password-stdin\` · \`plasalid vault list\` · \`plasalid vault rm <patternOrId> --yes\`.

## Transactions & ledger

- \`plasalid transactions add [--resolve] --debit-account <id> --credit-account <id> --amount <n> [--date <d>] [--description <t>] [--merchant-name <n>]\` — add one transaction; strict by default (unknown account ids fail with exit 5), \`--resolve\` fuzzy-resolves account/merchant hints and raises questions. \`--description\` defaults to the merchant name or "Manual entry". Also accepts a JSON transaction object on stdin.
- \`plasalid transactions recategorize --set-account <id> --filter-account <id>\` — bulk re-point matching transactions off \`--filter-account\` onto \`--set-account\` (both required).
- \`plasalid transactions update <tx:id> [--date <d>] [--description <t>] [--merchant <id>]\` (>= 1 flag required) · \`plasalid transactions delete <tx:id> --yes\`.
- \`plasalid ledger [--account <id>] [--from <d>] [--to <d>] [--query <t>] [--limit <n>] [--group] [--redact]\` — list transactions (\`--account\` matches either side; \`--group\` folds linked transactions into clusters) · \`plasalid ledger show <tx:id> [--redact]\` — one transaction with its linked group.

## Accounts

- \`plasalid accounts list [--type <t>] [--redact]\` · \`plasalid accounts tree [--type <t>]\` · \`plasalid accounts show <id>\`. Each account carries \`balance\`, \`debits_posted\`, and \`credits_posted\` (decimals); \`tree\` adds per-node \`rollup\`.
- \`plasalid accounts create --id <id> --name <n> --type <t> [--parent <id>] [--subtype <s>] [--bank <n>] [--masked <num>] [--currency <c>] [--due-day <n>] [--statement-day <n>] [--metadata <json>]\` — when \`--parent\` is omitted, missing colon-path ancestors are auto-created (returned as \`created_parents\`); still run \`accounts match\` first to avoid a near-duplicate.
- \`plasalid accounts merge --from <id> --to <id> --yes\` · \`plasalid accounts delete <id> --yes\`.
- \`plasalid accounts adjust <id> --to <amount> --reason <t> [--date <d>]\` — post a balancing adjustment to reach a target balance.
- \`plasalid accounts match --query <t>\` — fuzzy lookup before create.
- \`plasalid accounts update <id> [--name <n>] [--due-day <n>] [--statement-day <n>] [--points <n>] [--masked <num>] [--bank <n>] [--metadata <json>]\` (>= 1 flag required) — renames when \`--name\` is given, patches metadata for the rest.

## Merchants

- \`plasalid merchants list\` · \`plasalid merchants resolve --descriptor <t>\`.
- \`plasalid merchants upsert --name <canonical> [--alias <a>] [--default-account <id>]\`.
- \`plasalid merchants set-default --merchant <id> [--account <id> | --clear]\` — exactly one of \`--account\`/\`--clear\` required; \`--clear\` removes the default.

## Questions, reports, analysis, notes

- \`plasalid questions list [--batch <sc:id>] [--include-deferred] [--redact]\`.
- \`plasalid questions answer <cn:id> --answer <t> [--also <id,id>]\` · \`plasalid questions defer <cn:id> [--days <n>]\`.
- Net worth comes from \`plasalid status --json\` (the \`net_worth\` block). \`plasalid report period --from <d> --to <d>\` — income/expenses/net over a range.
- \`plasalid analyze duplicates [--auto-merge]\` — likely duplicate transactions · \`plasalid analyze correlations\` — internal-transaction pairs.
- \`plasalid notes list\` · \`plasalid notes add --content <t> [--category <c>]\` · \`plasalid notes rm <id> --yes\`.
`;

// references/schemas.md

export const SCHEMAS_MD = `# plasalid schemas

## Ingest prepare output (\`ingest prepare <pathOrId> --json\`)

Default format is \`pdf\`:

\`\`\`json
{"file_id":"sf:...","format":"pdf","document":"/abs/path/to/statement.pdf","page_count":3,"pages":[{"page":0,"path":"/abs/path/to/statement.pdf"}]}
\`\`\`

\`document\` is the PDF to Read directly (your model reads PDFs natively). When the source PDF is not encrypted, \`document\` IS the original data-dir path — nothing is written to disk. When it was encrypted, \`document\` is a decrypted copy under the cache dir (cleared by \`ingest done\`/\`ingest fail\`).

When your Read tool cannot open PDFs, rasterize to page PNGs instead: \`plasalid ingest prepare <sf:id> --format png --dpi 200 --json\`. plasalid uses a bundled rasterizer (no poppler or other system dependency to install); \`pages\` then lists one PNG per page to Read, and \`dpi\` echoes the resolution used (default 150):

\`\`\`json
{"file_id":"sf:...","format":"png","dpi":200,"page_count":3,"pages":[{"page":0,"path":"/cache/.../p0.png"}]}
\`\`\`

## Ingest commit input

\`plasalid ingest commit\` reads either NDJSON (one object per line) or a single
JSON array — from a file passed via \`--input <path>\` (preferred for agents:
stage the batch with your file tools) or from stdin. One object = one transaction
item (standalone or compound):

| field | type | required | notes |
|---|---|---|---|
| \`date\` | string | yes | ISO \`YYYY-MM-DD\`. Convert Buddhist-Era years (year - 543). |
| \`description\` | string | yes | Human-readable summary of the row. |
| \`debit_account\` | string | yes* | The account to DEBIT. HINT (see resolution). Alias: \`debit_account_id\`. |
| \`credit_account\` | string | yes* | The account to CREDIT. HINT. Alias: \`credit_account_id\`. |
| \`amount\` | number | yes* | Decimal as printed, > 0, in the accounts' currency. Stored as integer minor units. |
| \`linked\` | array | no | Compound item: OMIT top-level \`debit_account\`/\`credit_account\`/\`amount\` and give an array of legs \`{debit_account, credit_account, amount, description?, currency?, code?}\` that commit atomically under one shared \`group_id\` (a payslip, a loan payment, an FX pair). |
| \`currency\` | string | no | Hint only; defaults \`THB\`. The STORED currency is derived from the resolved accounts, never obeyed from input — a differing hint is ignored (\`transactions add --resolve\` surfaces this as \`currency_overridden\`). |
| \`code\` | string | no | External reference/code, carried onto the transaction. |
| \`raw_descriptor\` | string | no | Verbatim bank text. Drives merchant-alias learning. |
| \`source_page\` | number | no | Page the row came from. Part of the derived id — set it whenever \`row_index\` is set. |
| \`row_index\` | number | no | Row position on the page (0-based, reading order). With \`source_page\` + \`--file\`, makes re-scans idempotent (deterministic id). |
| \`source_file_id\` | string | no | \`sf:...\` id; falls back to \`--file\`. Supplies the file hash used for id derivation. |
| \`merchant\` | object | no | \`{canonical_name (required), alias?, default_account_id?}\`. Upserted; alias learned. |
| \`merchant_id\` | string | no | Pre-resolved merchant id. Overrides \`merchant\`. Unknown id raises \`unknown_merchant\`. |
| \`id\` | string | no | Explicit transaction id. Ignored when a deterministic id can be derived. |
| \`group_id\` | string | no | Explicit group id for a compound item; derived (\`tg:\`) from file hash + page + row when omitted. |

\\* Required for a standalone item; supplied per-leg inside \`linked\` for a compound item.

**Standalone vs compound.** In a compound (\`linked\`) item the envelope carries the shared fields — \`date\`, \`description\`, \`raw_descriptor\`, \`source_page\`, \`row_index\`, \`merchant\`/\`merchant_id\`, \`group_id\` — and each leg carries its own \`debit_account\`/\`credit_account\`/\`amount\` (+ optional \`description\`/\`currency\`/\`code\`). Put \`row_index\` on the envelope, not on the legs; each leg's id derives from the envelope \`row_index\` plus its position.

**Hint resolution.** Each side's account id is resolved: exact -> fuzzy (>= 0.7) -> new placeholder account -> \`expense:uncategorized\`. Resolution never blocks; it commits and raises a question.

**Currency.** Every transaction (each leg) must be currency-homogeneous — both of its accounts share one currency. A cross-currency row is dropped with a \`currency_mismatch\` question; post it as a \`linked\` conversion pair, one leg per currency, through \`equity:conversion:<ccy>\`.

**Deterministic ids.** With a source file (its \`file_hash\`, resolved from \`--file\`/\`source_file_id\`) and a \`row_index\`, the transaction id is \`tx:\` + first 16 hex of \`sha256("<file_hash>|<page>|<row_index>")\` (plus \`|<leg_index>\` per linked leg); the group id is \`tg:\` + the same hash without the leg. \`page\` is \`source_page\` (0 when absent). Re-committing the same file+page+row is an idempotent no-op (\`duplicate:true\`). Without a file hash and \`row_index\`, ids are random and a re-ingest double-posts.

## Examples

Standalone transaction (a coffee bought on a bank debit card):

\`\`\`json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
\`\`\`

Compound / \`linked\` payslip (gross 60000 = net 50000 + tax 8000 + social security 2000, every leg crediting the shared \`income:salary\`):

\`\`\`json
{"date":"2025-01-25","description":"Acme payroll January","source_page":1,"row_index":0,"linked":[{"debit_account":"asset:bank:kbank","credit_account":"income:salary","amount":50000.00,"description":"Net pay"},{"debit_account":"expense:tax","credit_account":"income:salary","amount":8000.00,"description":"Withholding tax"},{"debit_account":"expense:social-security","credit_account":"income:salary","amount":2000.00,"description":"Social security"}]}
\`\`\`

Cross-currency as a conversion pair (36000 THB out, 1000 USD in; each leg homogeneous, linked through \`equity:conversion:<ccy>\`):

\`\`\`json
{"date":"2025-04-02","description":"THB to USD transaction","source_page":3,"row_index":0,"linked":[{"debit_account":"equity:conversion:thb","credit_account":"asset:bank:kbank","amount":36000.00,"currency":"THB","description":"THB out"},{"debit_account":"asset:bank:wise-usd","credit_account":"equity:conversion:usd","amount":1000.00,"currency":"USD","description":"USD in"}]}
\`\`\`

## Ingest commit output (NDJSON)

Per input item, one \`result\`, then a terminal \`summary\`.

Success (standalone transaction):

\`\`\`json
{"type":"result","index":0,"ok":true,"transaction_id":"tx:...","duplicate":false,"raised_questions":1,"merchant":{"how":"linked","merchant_id":"m:..."},"sides":[{"side":"debit","requested":"expense:food:coffee","resolved":"expense:food:coffee","how":"exact"},{"side":"credit","requested":"asset:bank:kbank","resolved":"asset:bank:kbank","how":"exact"}]}
\`\`\`

Success (compound / \`linked\`): \`group_id\` + \`legs\` replace \`transaction_id\` + \`sides\`.

\`\`\`json
{"type":"result","index":1,"ok":true,"group_id":"tg:...","legs":[{"transaction_id":"tx:...","duplicate":false}],"duplicate":false,"raised_questions":0,"merchant":{"how":"none"}}
\`\`\`

- \`merchant.how\`: \`none\` (none supplied) | \`unknown\` (id did not exist) | \`linked\` (\`merchant_id\` present).
- side \`how\`: \`exact\` | \`fuzzy_matched\` | \`placeholder_created\` | \`uncategorized_fallback\`. \`requested\` is your hint; \`resolved\` is what was actually posted.
- \`duplicate\` is true when the transaction already existed (idempotent re-commit) — a success, not a failure.

Failure (validation or currency): the item is dropped and a question is raised.

\`\`\`json
{"type":"result","index":2,"ok":false,"reason":"dirty_input","message":"...","raised_questions":1}
\`\`\`

\`reason\` is \`dirty_input\` or \`currency_mismatch\`.

Summary (batch id is the \`scan_id\` questions attach to; exit 7 when \`failed\` > 0; duplicates are counted separately and are NOT failures):

\`\`\`json
{"type":"summary","batch_id":"sc:...","posted":3,"duplicates":1,"failed":1,"raised_questions":2}
\`\`\`

## Question row (from \`questions list --json\`)

\`\`\`json
{"id":"cn:...","kind":"uncategorized","prompt":"...","transaction_id":null,"account_id":"expense:...","options":null,"context":{"rule_key":"...","placeholder_id":"expense:..."},"file_id":"sf:...","created_at":"..."}
\`\`\`

\`kind\` is free text; the values the pipeline raises are:

- \`dirty_input\` — a row failed validation and was not posted.
- \`unknown_merchant\` — \`merchant_id\` referenced a missing merchant. \`context\`: \`descriptor\`, \`attempted_id\`.
- \`uncategorized\` — a placeholder account was created. \`context\`: \`placeholder_id\`, \`side\`.
- \`similar_accounts\` — a hint fuzzy-matched an existing account. \`context\`: \`original_id\`, \`matched_id\`, \`side\`.
- \`currency_mismatch\` — a transaction's debit and credit accounts use different currencies. \`context\`: \`debit\`, \`credit\`.

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

// AGENTS.md block (codex)

/** Condensed skill wrapped in replace-in-place markers for codex AGENTS.md. */
export function AGENTS_MD_BLOCK(version: string): string {
  return `${CODEX_BEGIN_MARKER} v${version} -->
## plasalid (finance harness)

\`plasalid\` is a deterministic CLI over a local double-entry ledger; you supply the intelligence.

- **Always pass \`--json\`** (NDJSON out; streams end with a \`{"type":"summary"}\` line). Orient with \`plasalid status --json\` first.
- **Never invent ids.** Find them via \`accounts match\`, \`merchants resolve\`, or a \`list\`. File ids are \`sf:...\`, transactions \`tx:...\`, questions \`cn:...\`, merchants \`m:...\`.
- **No prompts.** Destructive ops need \`--yes\`; passwords via \`--password-stdin\` or the vault.
- **Exit codes:** 0 ok · 1 error · 2 usage · 3 not-ready · 4 need password/\`--yes\` (ask the human, retry) · 5 wrong id (list to find it) · 6 invalid input · 7 batch partial (inspect results + questions; duplicates are NOT failures). Errors are \`{"error":{code,message,hint}}\` on stderr. Full exit-code table + result/question schemas: \`references/schemas.md\`.
- **When blocked (environment, not the harness):** cannot Read the PDF -> \`ingest prepare <sf:id> --format png --dpi 200 --json\` and Read the page PNGs (bundled rasterizer, no system deps). Cannot stage the \`--input\` batch -> write it in the cwd; if Write stays blocked, ask the human; only as a last resort \`transactions add --resolve\` per row (and warn that this loses idempotency + source-file linkage). Run ONE \`plasalid\` command per shell call — no \`&&\`/\`;\`/\`echo\` chaining, no heredoc JSON.
- **Double-entry (transactions):** every entry is one transaction — debit exactly one account, credit exactly one account, single positive amount (direction is WHICH account, never a sign). Normal balances: \`asset\`/\`expense\` up on debit; \`liability\`/\`income\`/\`equity\` up on credit. Card purchase = debit \`expense:<cat>\` / credit \`liability:credit_card:<x>\`; bank spend = debit \`expense:<cat>\` / credit \`asset:bank:<x>\`; salary = debit \`asset:bank:<x>\` / credit \`income:salary\`; a refund or card payment flips the card side (full direction table in SKILL.md). Splits (payslip, loan payment, FX) are a compound \`linked:[...]\` sharing one group. A cross-currency move is a linked conversion pair through \`equity:conversion:<ccy>\`, never one transaction. Accounts are colon-paths under \`asset|liability|income|expense|equity\`. Amounts decimal THB; dates ISO (Thai Buddhist-Era years minus 543).

**Ingest:** \`ingest list\` -> \`ingest prepare <id>\` (accepts the \`path\`/\`rel_path\` or the \`sf:\` id from any cwd; exit 4 -> ask for password, retry \`--password-stdin\`) -> Read the returned \`document\` PDF directly (or \`ingest prepare <sf:id> --format png --dpi 200\` and Read the PNGs if you cannot Read PDFs) -> build NDJSON transaction items in a file -> \`ingest commit --file <sf:id> --input <path>\` -> \`questions list --batch <batch_id>\` -> \`ingest done <id> --agent codex\`. Each item is \`{date, description, debit_account, credit_account, amount, ...}\` (or a compound \`linked:[...]\`); the account ids are hints (exact -> fuzzy -> placeholder -> uncategorized). Number each row with \`row_index\` (0-based, per page) + \`source_page\` and pass \`--file <sf:id>\` so re-ingest is an idempotent no-op (\`duplicate:true\`). Always send \`raw_descriptor\` + \`merchant:{canonical_name,alias}\`. When the statement header implies opening balances, post them per the direction table (\`equity:opening-balance\`) and report what you posted — do not ask first; persist card metadata with \`accounts update <liability:credit_card:x> --masked <digits> ...\` (masked numbers keep their literal trailing digits).

**Clarify:** \`questions list\`; similar_accounts -> \`accounts merge\`; uncategorized -> \`transactions recategorize\` + \`merchants set-default\`; unknown_merchant -> \`merchants upsert\`; currency_mismatch -> re-post as a linked conversion pair; answer with \`questions answer <id> --answer ...\` (\`--also\` for siblings), or \`questions defer\`. Durable prefs/rules: \`notes add --content ... --category preference\` (check \`notes list\` first).

**Report:** net worth via \`plasalid status --json\` (\`net_worth\` block); \`report period --from --to\`, \`accounts tree\`, \`ledger\`, \`analyze duplicates|correlations\`.

If a fuller skill is installed at \`.claude/skills/plasalid/\`, prefer its \`references/\` docs for exact flags and schemas.
${CODEX_END_MARKER}`;
}
