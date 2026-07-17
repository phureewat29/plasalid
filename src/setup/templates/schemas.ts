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
