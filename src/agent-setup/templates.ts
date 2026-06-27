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

You drive \`plasalid\`, a deterministic CLI over a local double-entry ledger. It has no AI loop of its own — you are the intelligence. Every command is scriptable and non-interactive.

## 1. Golden rules

- **Always pass \`--json\`.** Output becomes NDJSON: one object per line, and streaming commands close with a \`{"type":"summary",...}\` line. Never scrape the human tables.
- **Orient first.** Run \`plasalid status --json\` before acting — it reports config, database, ledger counts, and net worth.
- **Never invent ids.** Account paths and merchant / file (\`sf:\`) / transfer (\`tf:\`) / question (\`cn:\`) ids all come from the harness — discover them with \`accounts match\`, \`merchants resolve\`, or a \`list\` first.
- **The harness never prompts.** Destructive commands need \`--yes\`. Passwords arrive via \`--password-stdin\` or the vault. There is no stdin prompt to wait on.
- **Branch on the exit code, not stderr prose:** 0 ok · 1 error (inspect; retry or report) · 2 usage (fix the command line) · 3 not-ready (run \`plasalid doctor --json\`) · 4 input required (password or \`--yes\` missing — ask the human, retry) · 5 not-found (wrong id — \`list\`/\`match\`) · 6 invalid input (fix, resend) · 7 partial (batch partly failed — inspect each \`result\` + raised questions). Full table in \`references/schemas.md\`.
- **Errors** print one object on stderr: \`{"error":{"code":"E_...","message":...,"hint":...}}\`. Always read \`hint\`.
- **Statement rows go through \`ingest commit --file <sf:id>\` — never \`record\`.** Batch every extracted row (with its \`row_index\`) into ONE \`ingest commit\` call: that links transfers to the source file and makes re-ingest idempotent (\`duplicate:true\` instead of double-posting). \`record\` is only for manual one-off entries the user dictates with no source document.

## 2. Core concepts

- **Every entry is a _transfer_.** It debits exactly one account and credits exactly one account by a single positive amount. Direction is WHICH account is debit vs credit — never a sign. Wire amounts are DECIMAL as printed (\`135.00\`); the harness stores integer minor units (satang, cents).
- **Normal balances.** \`asset\` and \`expense\` accounts increase by a DEBIT; \`liability\`, \`income\`, and \`equity\` increase by a CREDIT. Choose the two sides by which account each half of the line grows.
- **Accounts** are colon-paths under five roots — \`asset\`, \`liability\`, \`income\`, \`expense\`, \`equity\` (e.g. \`expense:food:groceries\`). Reuse before you create: \`plasalid accounts match --query <name> --json\`.

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

- **Compound entries = shared-leg decomposition.** A split statement line becomes a compound item: \`linked\` legs that commit atomically under one \`group_id\`. Find the ONE account every leg shares — do NOT invent clearing accounts.
  - _Payslip_ (3 legs, all crediting \`income:salary\`): net \`50000\` -> \`asset:bank:<x>\`, withholding tax \`8000\` -> \`expense:tax\`, social security \`2000\` -> \`expense:social-security\` (\`income:salary\` = gross \`60000\`).
  - _Loan payment_ (2 legs, both crediting \`asset:bank:<x>\`): principal -> \`liability:loan:<x>\`, interest -> \`expense:interest\`.
- **Idempotency.** Put \`row_index\` (0-based, reading order, per page) + \`source_page\` on every item and pass \`--file <sf:id>\`; the harness derives a stable id from file hash + page + row, so re-ingesting never double-posts (\`duplicate:true\`). Never renumber rows between retries.
- **Currency.** A transfer's two accounts must share a currency (the stored currency is derived from the resolved accounts, never trusted from input). A cross-currency row is dropped with a \`currency_mismatch\` question — record it as two linked transfers, one per currency, through \`equity:conversion:<ccy>\` (pattern in \`references/schemas.md\`). Thai statements print Buddhist-Era years — subtract 543 (2568 -> 2025).
- **Corrections.** Wrong category -> \`plasalid record recategorize\` (re-points it in place). Wrong amount or currency -> \`plasalid record delete\` then re-ingest that row from the PDF. A refund is an ordinary forward transfer (see the table), never an edit of the original.
- **Account ids are HINTS.** Each side resolves exact -> fuzzy (>= 0.7) -> new placeholder -> \`expense:uncategorized\`, committing and raising a question rather than blocking. Send \`raw_descriptor\` + \`merchant:{canonical_name, alias}\` so aliases are learned. Internal transfers landing on two statements: \`plasalid analyze correlations\`.

## 3. Workflow: ingest statements

1. \`plasalid ingest list --json\` — every PDF with its status (\`new\`/\`pending\`/\`scanned\`/\`failed\`), \`file_id\`, and whether it is encrypted.
2. Per new/pending file: \`plasalid ingest prepare <pathOrId> --json\` — registers/unlocks the PDF and exports page PNGs (paths in the result).
   - Exit 4 means encrypted and locked. Ask the human for the password, then retry: \`printf '%s' "$PW" | plasalid ingest prepare <id> --password-stdin --json\`. Persist it with \`plasalid vault add <pattern> --password-stdin\`.
3. **Read the exported PNG pages** — they are image files; view them.
4. Extract every row into one NDJSON transfer item (schema in section 7 / \`references/schemas.md\`). Number rows with \`row_index\` (0-based, per page) and set \`source_page\` so the commit is idempotent.
5. Commit: \`... | plasalid ingest commit --file <sf:id> --json\`. Each line returns a \`result\`; the \`summary\` carries \`batch_id\`, \`posted\`, \`duplicates\`, \`failed\`. Exit 7 = some rows failed — inspect each \`result\` (a \`duplicate\` is a successful no-op, not a failure).
6. \`plasalid questions list --batch <batch_id> --json\` — resolve with the human or defer (section 4).
7. \`plasalid ingest done <sf:id> --agent claude-code --json\`. (On unrecoverable failure: \`plasalid ingest fail <sf:id> --error "<why>" --json\`.)

## 4. Workflow: clear the question backlog

\`plasalid questions list --json\`, then handle by \`kind\`:
- **similar_accounts** — a near-duplicate account. If truly the same: \`plasalid accounts merge --from <id> --to <id> --yes --json\`.
- **uncategorized** (a placeholder was created) — pick the real account, then \`plasalid record recategorize --set-account <id> --filter-account <placeholder> --json\`, and make it stick: \`plasalid merchants set-default --merchant <id> --account <id> --json\`.
- **unknown_merchant** — link it with \`plasalid merchants upsert --name <canonical> --alias <descriptor> --json\`.
- **currency_mismatch** — the row crossed currencies and was dropped; re-record it as a linked conversion pair (section 2).
- Answer with \`plasalid questions answer <id> --answer "<text>" --json\` (\`--also <id,id>\` closes siblings); \`plasalid questions defer <id> --days <n> --json\` when unknowable.
- Durable user preference/rule learned while clarifying? Record it: \`plasalid notes add --content "..." --category preference --json\` (check \`plasalid notes list --json\` first).

## 5. Workflow: record a natural-language expense

Example: "300 baht lunch, cash".
1. Find real ids: \`plasalid accounts match --query cash --json\` and \`... --query food --json\` (create with \`accounts create\` if missing).
2. \`plasalid record --debit-account expense:food --credit-account asset:cash --amount 300 --json\` (one transfer out of cash into the food expense). \`--resolve\` fuzzy-resolves hint ids and raises questions instead of failing on an unknown id.

## 6. Workflow: reporting

- Net worth: \`plasalid status --json\` (\`net_worth\`: assets, liabilities, net_worth).
- Per-account totals: \`plasalid accounts list --json\` / \`plasalid accounts show <id> --json\` carry \`balance\`, \`debits_posted\`, \`credits_posted\`; \`plasalid accounts tree --json\` adds rollups.
- \`plasalid report period --from <date> --to <date> --json\` — income/expenses/net over a range.
- \`plasalid ledger --json\` (filter \`--account\`/\`--query\`/\`--from\`/\`--to\`, or \`--group\` to fold linked transfers); \`plasalid ledger show <tf:id> --json\` shows a transfer with its group.
- \`plasalid analyze duplicates --json\` (add \`--auto-merge\`); \`plasalid analyze correlations --json\` (internal-transfer pairs).

## 7. Cheat sheet + ingest schema

\`status\` · \`doctor\` · \`setup\` · \`agent-setup\` · \`config\` · \`ingest\` · \`files\` · \`vault\` · \`record\` · \`ledger\` · \`accounts\` · \`merchants\` · \`questions\` · \`report\` · \`analyze\` · \`notes\` · \`context\` · \`data\` — every subcommand and flag is in \`references/commands.md\`.

One standalone transfer item (NDJSON, piped to \`ingest commit\`):

\`\`\`json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
\`\`\`

A compound (split) item replaces top-level \`debit_account\`/\`credit_account\`/\`amount\` with \`linked:[...]\` — legs commit atomically under one group (payslip, loan payment, FX pair):

\`\`\`json
{"date":"2025-01-25","description":"Acme payroll January","source_page":1,"row_index":0,"linked":[{"debit_account":"asset:bank:kbank","credit_account":"income:salary","amount":50000.00,"description":"Net pay"},{"debit_account":"expense:tax","credit_account":"income:salary","amount":8000.00,"description":"Withholding tax"},{"debit_account":"expense:social-security","credit_account":"income:salary","amount":2000.00,"description":"Social security"}]}
\`\`\`

- \`date\`, \`description\`, \`debit_account\`, \`credit_account\`, \`amount\` (> 0) are required (per-leg inside \`linked\`); account ids are HINTS (section 2). Set \`row_index\` + \`source_page\` and pass \`--file <sf:id>\` for idempotency; send \`raw_descriptor\` + \`merchant\` to learn aliases.

More detail: schemas + exit codes in \`references/schemas.md\`; commands and flags in \`references/commands.md\`; Thai institutions in \`references/taxonomy.md\`.
`;
}

// --- references/commands.md ------------------------------------------------

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
- \`plasalid setup [--data-dir <dir>] [--db <path>] [--generate-key | --encryption-key-stdin] [--locale <l>] [--currency <c>] [--user-name <n>] [--force]\` — headless init.
- \`plasalid config show\` · \`plasalid config set [--data-dir <dir>] [--db <path>] [--locale <l>] [--currency <c>] [--user-name <n>] [--encryption-key-stdin]\` (>= 1 flag required) · \`plasalid config path\`.
- \`plasalid context show\` · \`plasalid context path\`.
- \`plasalid agent-setup [--claude] [--codex] [--global] [--dir <path>] [--force] [--print]\` — install/refresh this skill pack for an agent CLI.
- \`plasalid data\` — open the data folder in the OS file explorer (alias: \`open\`).

## Ingest pipeline

- \`plasalid ingest list [--regex <pattern>]\` — discover data-dir PDFs vs the db.
- \`plasalid ingest prepare <pathOrId> [--password-stdin] [--force] [--format png|pdf] [--dpi <n>] [--pages "1-5,8"] [--out <dir>]\` — register + unlock + export pages for you to Read. Exit 4 when a password is required.
- \`plasalid ingest commit [--file <sf:id>] [--scan-id <sc:id>]\` — read NDJSON/JSON-array transfer items from stdin, post them, mint a batch id, return per-item results + summary. Exit 7 on partial failure (duplicates are a successful no-op).
- \`plasalid ingest done <sf:id> [--agent <name>] [--note <text>]\` — mark scanned (clears the page cache).
- \`plasalid ingest fail <sf:id> --error <text> [--agent <name>]\` — mark failed (also clears the page cache).

## Files & vault

- \`plasalid files list [--status new|pending|scanned|failed]\` · \`plasalid files show <sf:id>\` · \`plasalid files drop <sf:id> --yes\` (cascades transfers + questions).
- \`plasalid vault add <pattern> --password-stdin\` · \`plasalid vault list\` · \`plasalid vault rm <patternOrId> --yes\`.

## Records & ledger

- \`plasalid record [--resolve] --debit-account <id> --credit-account <id> --amount <n> [--currency <c>] [--date <d>] [--description <t>] [--merchant-name <n>]\` — record one transfer; strict by default (unknown account ids fail with exit 5), \`--resolve\` fuzzy-resolves account/merchant hints and raises questions. \`--description\` defaults to the merchant name or "Manual entry". Also accepts a JSON transfer object on stdin.
- \`plasalid record recategorize --set-account <id> --filter-account <id> [--filter-desc <t>] [--filter-merchant <id>] [--filter-currency <c>] [--from <d>] [--to <d>]\` — bulk re-point matching transfers off \`--filter-account\` onto \`--set-account\` (both required).
- \`plasalid record update <tf:id> [--date <d>] [--description <t>] [--merchant <id>] [--source-page <n>]\` (>= 1 flag required) · \`plasalid record delete <tf:id> --yes\`.
- \`plasalid ledger [--account <id>] [--from <d>] [--to <d>] [--query <t>] [--limit <n>] [--group] [--redact]\` — list transfers (\`--account\` matches either side; \`--group\` folds linked transfers into clusters) · \`plasalid ledger show <tf:id> [--redact]\` — one transfer with its linked group.

## Accounts

- \`plasalid accounts list [--type <t>] [--redact]\` · \`plasalid accounts tree [--type <t>]\` · \`plasalid accounts show <id>\`. Each account carries \`balance\`, \`debits_posted\`, and \`credits_posted\` (decimals); \`tree\` adds per-node \`rollup\`.
- \`plasalid accounts create --id <id> --name <n> --type <t> [--parent <id>] [--subtype <s>] [--bank <n>] [--masked <num>] [--currency <c>] [--due-day <n>] [--statement-day <n>] [--metadata <json>]\`.
- \`plasalid accounts merge --from <id> --to <id> --yes\` · \`plasalid accounts delete <id> --yes\`.
- \`plasalid accounts adjust <id> --to <amount> --reason <t> [--date <d>]\` — post a balancing adjustment to reach a target balance.
- \`plasalid accounts match --query <t> [--threshold <n>]\` — fuzzy lookup before create.
- \`plasalid accounts update <id> [--name <n>] [--due-day <n>] [--statement-day <n>] [--points <n>] [--masked <num>] [--bank <n>] [--metadata <json>]\` (>= 1 flag required) — renames when \`--name\` is given, patches metadata for the rest.

## Merchants

- \`plasalid merchants list [--with-default-only] [--limit <n>]\` · \`plasalid merchants resolve --descriptor <t>\`.
- \`plasalid merchants upsert --name <canonical> [--alias <a>] [--default-account <id>]\`.
- \`plasalid merchants set-default --merchant <id> [--account <id> | --clear]\` — exactly one of \`--account\`/\`--clear\` required; \`--clear\` removes the default.

## Questions, reports, analysis, notes

- \`plasalid questions list [--kind <k>] [--file <sf:id>] [--batch <sc:id>] [--include-deferred] [--limit <n>] [--redact]\`.
- \`plasalid questions answer <cn:id> --answer <t> [--also <id,id>]\` · \`plasalid questions defer <cn:id> [--days <n>]\`.
- Net worth comes from \`plasalid status --json\` (the \`net_worth\` block). \`plasalid report period --from <d> --to <d>\` — income/expenses/net over a range.
- \`plasalid analyze duplicates [--tolerance-days <n>] [--account <id>] [--min-amount <n>] [--auto-merge]\` — likely duplicate transfers · \`plasalid analyze correlations [--from <d>] [--to <d>] [--tolerance-days <n>] [--min-amount <n>]\` — internal-transfer pairs.
- \`plasalid notes list\` · \`plasalid notes add --content <t> [--category <c>]\` · \`plasalid notes rm <id> --yes\`.
`;

// --- references/schemas.md -------------------------------------------------

export const SCHEMAS_MD = `# plasalid schemas

## Ingest commit input (stdin)

\`plasalid ingest commit\` reads either NDJSON (one object per line) or a single
JSON array. One object = one transfer item (standalone or compound):

| field | type | required | notes |
|---|---|---|---|
| \`date\` | string | yes | ISO \`YYYY-MM-DD\`. Convert Buddhist-Era years (year - 543). |
| \`description\` | string | yes | Human-readable summary of the row. |
| \`debit_account\` | string | yes* | The account to DEBIT. HINT (see resolution). Alias: \`debit_account_id\`. |
| \`credit_account\` | string | yes* | The account to CREDIT. HINT. Alias: \`credit_account_id\`. |
| \`amount\` | number | yes* | Decimal as printed, > 0, in the accounts' currency. Stored as integer minor units. |
| \`linked\` | array | no | Compound item: OMIT top-level \`debit_account\`/\`credit_account\`/\`amount\` and give an array of legs \`{debit_account, credit_account, amount, description?, currency?, code?}\` that commit atomically under one shared \`group_id\` (a payslip, a loan payment, an FX pair). |
| \`currency\` | string | no | Hint only; defaults \`THB\`. The STORED currency is derived from the resolved accounts (a differing hint is reported as \`currency_overridden\`, not obeyed). |
| \`code\` | string | no | External reference/code, carried onto the transfer. |
| \`raw_descriptor\` | string | no | Verbatim bank text. Drives merchant-alias learning. |
| \`source_page\` | number | no | Page the row came from. Part of the derived id — set it whenever \`row_index\` is set. |
| \`row_index\` | number | no | Row position on the page (0-based, reading order). With \`source_page\` + \`--file\`, makes re-scans idempotent (deterministic id). |
| \`source_file_id\` | string | no | \`sf:...\` id; falls back to \`--file\`. Supplies the file hash used for id derivation. |
| \`merchant\` | object | no | \`{canonical_name (required), alias?, default_account_id?}\`. Upserted; alias learned. |
| \`merchant_id\` | string | no | Pre-resolved merchant id. Overrides \`merchant\`. Unknown id raises \`unknown_merchant\`. |
| \`id\` | string | no | Explicit transfer id. Ignored when a deterministic id can be derived. |
| \`group_id\` | string | no | Explicit group id for a compound item; derived (\`tg:\`) from file hash + page + row when omitted. |

\\* Required for a standalone item; supplied per-leg inside \`linked\` for a compound item.

**Standalone vs compound.** In a compound (\`linked\`) item the envelope carries the shared fields — \`date\`, \`description\`, \`raw_descriptor\`, \`source_page\`, \`row_index\`, \`merchant\`/\`merchant_id\`, \`group_id\` — and each leg carries its own \`debit_account\`/\`credit_account\`/\`amount\` (+ optional \`description\`/\`currency\`/\`code\`). Put \`row_index\` on the envelope, not on the legs; each leg's id derives from the envelope \`row_index\` plus its position.

**Hint resolution.** Each side's account id is resolved: exact -> fuzzy (>= 0.7) -> new placeholder account -> \`expense:uncategorized\`. Resolution never blocks; it commits and raises a question.

**Currency.** Every transfer (each leg) must be currency-homogeneous — both of its accounts share one currency. A cross-currency row is dropped with a \`currency_mismatch\` question; record it as a \`linked\` conversion pair, one leg per currency, through \`equity:conversion:<ccy>\`.

**Deterministic ids.** With a source file (its \`file_hash\`, resolved from \`--file\`/\`source_file_id\`) and a \`row_index\`, the transfer id is \`tf:\` + first 16 hex of \`sha256("<file_hash>|<page>|<row_index>")\` (plus \`|<leg_index>\` per linked leg); the group id is \`tg:\` + the same hash without the leg. \`page\` is \`source_page\` (0 when absent). Re-committing the same file+page+row is an idempotent no-op (\`duplicate:true\`). Without a file hash and \`row_index\`, ids are random and a re-ingest double-posts.

## Examples

Standalone transfer (a coffee bought on a bank debit card):

\`\`\`json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
\`\`\`

Compound / \`linked\` payslip (gross 60000 = net 50000 + tax 8000 + social security 2000, every leg crediting the shared \`income:salary\`):

\`\`\`json
{"date":"2025-01-25","description":"Acme payroll January","source_page":1,"row_index":0,"linked":[{"debit_account":"asset:bank:kbank","credit_account":"income:salary","amount":50000.00,"description":"Net pay"},{"debit_account":"expense:tax","credit_account":"income:salary","amount":8000.00,"description":"Withholding tax"},{"debit_account":"expense:social-security","credit_account":"income:salary","amount":2000.00,"description":"Social security"}]}
\`\`\`

Cross-currency as a conversion pair (36000 THB out, 1000 USD in; each leg homogeneous, linked through \`equity:conversion:<ccy>\`):

\`\`\`json
{"date":"2025-04-02","description":"THB to USD transfer","source_page":3,"row_index":0,"linked":[{"debit_account":"equity:conversion:thb","credit_account":"asset:bank:kbank","amount":36000.00,"currency":"THB","description":"THB out"},{"debit_account":"asset:bank:wise-usd","credit_account":"equity:conversion:usd","amount":1000.00,"currency":"USD","description":"USD in"}]}
\`\`\`

## Ingest commit output (NDJSON)

Per input item, one \`result\`, then a terminal \`summary\`.

Success (standalone transfer):

\`\`\`json
{"type":"result","index":0,"ok":true,"transfer_id":"tf:...","duplicate":false,"raised_questions":1,"merchant":{"how":"linked","merchant_id":"m:..."},"sides":[{"side":"debit","requested":"expense:food:coffee","resolved":"expense:food:coffee","how":"exact"},{"side":"credit","requested":"asset:bank:kbank","resolved":"asset:bank:kbank","how":"exact"}]}
\`\`\`

Success (compound / \`linked\`): \`group_id\` + \`legs\` replace \`transfer_id\` + \`sides\`.

\`\`\`json
{"type":"result","index":1,"ok":true,"group_id":"tg:...","legs":[{"transfer_id":"tf:...","duplicate":false}],"duplicate":false,"raised_questions":0,"merchant":{"how":"none"}}
\`\`\`

- \`merchant.how\`: \`none\` (none supplied) | \`unknown\` (id did not exist) | \`linked\` (\`merchant_id\` present).
- side \`how\`: \`exact\` | \`fuzzy_matched\` | \`placeholder_created\` | \`uncategorized_fallback\`. \`requested\` is your hint; \`resolved\` is what was actually posted.
- \`duplicate\` is true when the transfer already existed (idempotent re-commit) — a success, not a failure.

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
{"id":"cn:...","kind":"uncategorized","prompt":"...","transfer_id":null,"account_id":"expense:...","options":null,"context":{"rule_key":"...","placeholder_id":"expense:..."},"file_id":"sf:...","created_at":"..."}
\`\`\`

\`kind\` is free text; the values the pipeline raises are:

- \`dirty_input\` — a row failed validation and was not posted.
- \`unknown_merchant\` — \`merchant_id\` referenced a missing merchant. \`context\`: \`descriptor\`, \`attempted_id\`.
- \`uncategorized\` — a placeholder account was created. \`context\`: \`placeholder_id\`, \`side\`.
- \`similar_accounts\` — a hint fuzzy-matched an existing account. \`context\`: \`original_id\`, \`matched_id\`, \`side\`.
- \`currency_mismatch\` — a transfer's debit and credit accounts use different currencies. \`context\`: \`debit\`, \`credit\`.

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
- **Never invent ids.** Find them via \`accounts match\`, \`merchants resolve\`, or a \`list\`. File ids are \`sf:...\`, transfers \`tf:...\`, questions \`cn:...\`.
- **No prompts.** Destructive ops need \`--yes\`; passwords via \`--password-stdin\` or the vault.
- **Exit codes:** 0 ok · 2 usage · 3 not-ready · 4 need password/\`--yes\` (ask the human, retry) · 5 wrong id (list to find it) · 6 invalid input · 7 batch partial (inspect results + questions; duplicates are NOT failures). Errors are \`{"error":{code,message,hint}}\` on stderr.
- **Double-entry (transfers):** every entry is one transfer — debit exactly one account, credit exactly one account, single positive amount (direction is WHICH account, never a sign). Normal balances: \`asset\`/\`expense\` up on debit; \`liability\`/\`income\`/\`equity\` up on credit. Card purchase = debit \`expense:<cat>\` / credit \`liability:credit_card:<x>\`; bank spend = debit \`expense:<cat>\` / credit \`asset:bank:<x>\`; salary = debit \`asset:bank:<x>\` / credit \`income:salary\`; a refund or card payment flips the card side (full direction table in SKILL.md). Splits (payslip, loan payment, FX) are a compound \`linked:[...]\` sharing one group. A cross-currency move is a linked conversion pair through \`equity:conversion:<ccy>\`, never one transfer. Accounts are colon-paths under \`asset|liability|income|expense|equity\`. Amounts decimal THB; dates ISO (Thai Buddhist-Era years minus 543).

**Ingest:** \`ingest list\` -> \`ingest prepare <id>\` (exit 4 -> ask for password, retry \`--password-stdin\`) -> Read the exported page PNGs -> build NDJSON transfer items -> \`ingest commit --file <sf:id>\` -> \`questions list --batch <batch_id>\` -> \`ingest done <id> --agent codex\`. Each item is \`{date, description, debit_account, credit_account, amount, ...}\` (or a compound \`linked:[...]\`); the account ids are hints (exact -> fuzzy -> placeholder -> uncategorized). Number each row with \`row_index\` (0-based, per page) + \`source_page\` and pass \`--file <sf:id>\` so re-ingest is an idempotent no-op (\`duplicate:true\`). Always send \`raw_descriptor\` + \`merchant:{canonical_name,alias}\`.

**Clarify:** \`questions list\`; similar_accounts -> \`accounts merge\`; uncategorized -> \`record recategorize\` + \`merchants set-default\`; unknown_merchant -> \`merchants upsert\`; currency_mismatch -> re-record as a linked conversion pair; answer with \`questions answer <id> --answer ...\` (\`--also\` for siblings), or \`questions defer\`. Durable prefs/rules: \`notes add --content ... --category preference\` (check \`notes list\` first).

**Report:** net worth via \`plasalid status --json\` (\`net_worth\` block); \`report period --from --to\`, \`accounts tree\`, \`ledger\`, \`analyze duplicates|correlations\`.

If a fuller skill is installed at \`.claude/skills/plasalid/\`, prefer its \`references/\` docs for exact flags and schemas.
${CODEX_END_MARKER}`;
}
