/**
 * SKILL.md (Claude Code) — the main agent-facing skill file. Kept focused; deep
 * detail lives in references/{commands,schemas,taxonomy}.md.
 *
 * Authoring note: this is a template literal, so all backticks are escaped as
 * \` and no literal `${` appears in prose (the only interpolation is the
 * injected version).
 */
export function SKILL_MD(version: string): string {
  return `---
name: plasalid
description: Drive plasalid, a local double-entry personal-finance harness, from the command line. Use for anything about the user's ledger, bank/credit-card statements, Thai bank PDFs, net worth, spending, accounts, transactions, merchants, or when the user names plasalid. Ingest statement PDFs, extract transactions, categorize accounts, resolve merchants, clear clarifying questions, and run net-worth / period reports. Installs the plasalid CLI from npm on first use. Use also when asked to install plasalid or set up personal finance tracking from bank statement PDFs.
version: ${version}
---

# plasalid

You drive \`plasalid\`, a deterministic CLI over a local double-entry ledger — no AI loop of its own, you are the intelligence. Every command is scriptable and non-interactive.

## Setup: get plasalid running

- **Detect:** run \`plasalid --version\` — if it prints a version, plasalid is installed; skip to Golden rules.
- **Install:** check \`node --version\` (Node >= 18 required). If Node is missing, STOP and ask the human to install it (nodejs.org, or Homebrew on macOS) — do not attempt OS-level installs yourself. Then \`npm install -g plasalid\`. On a permissions error (EACCES): \`npm install -g --prefix "$HOME/.npm-global" plasalid\` and invoke plasalid via \`$HOME/.npm-global/bin/plasalid\` from then on.
- **First run:** \`plasalid config --generate-key --json\` (creates ~/.plasalid with the config, encrypted database, and data directory), then \`plasalid doctor --json\` — every check must be ok before continuing.
- **Statements in:** the data directory path is \`dataDir\` in \`plasalid config show --json\`. On a desktop, \`plasalid data\` opens it in the file manager; in a sandboxed/VM environment ask the human to attach/upload the statement PDF and write it into the data directory yourself.

## Golden rules

- **Always pass \`--json\`.** NDJSON out: one object per line; streaming commands end with a \`{"type":"summary",...}\` line. Never scrape human tables.
- **Orient first:** \`plasalid status --json\` (config, database, ledger counts, net worth).
- **Never invent ids.** Account paths and \`sf:\` file / \`tx:\` transaction / \`cn:\` question / \`m:\` merchant ids all come from the harness — find them with \`accounts match\`, \`merchants resolve\`, or a \`list\`.
- **The harness never prompts.** Destructive commands need \`--yes\`; passwords go through \`--password-stdin\` or the vault.
- **Branch on the exit code:** 0 ok · 1 error · 2 usage · 3 not-ready (see the Setup section above, or run \`plasalid doctor --json\`) · 4 input required (password / \`--yes\` — ask the human, retry) · 5 not-found (wrong id — \`list\`/\`match\`) · 6 invalid · 7 partial (batch partly failed — inspect each \`result\`). Full table in \`references/schemas.md\`.
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
