---
name: plasalid
description: Drive plasalid, a local double-entry personal-finance harness, from the command line. Use for anything about the user's ledger, bank/credit-card statements, Thai bank PDFs, net worth, spending, accounts, transactions, merchants, or when the user names plasalid. Ingest statement PDFs, extract transactions, categorize accounts, resolve merchants, clear clarifying questions, and run net-worth / period reports. Installs the plasalid CLI from npm on first use. Use also when asked to install plasalid or set up personal finance tracking from bank statement PDFs.
---

# plasalid

You drive `plasalid`, a deterministic CLI over a local double-entry ledger — no AI loop of its own, you are the intelligence. Every command is scriptable and non-interactive.

## Setup: get plasalid running

- **Detect:** run `plasalid --version` — if it prints a version, plasalid is installed; skip the Install and First-run steps and go straight to the version check below.
- **Install:** check `node --version` (Node >= 18 required). If Node is missing, STOP and ask the human to install it (nodejs.org, or Homebrew on macOS) — do not attempt OS-level installs yourself. Then `npm install -g plasalid`. On a permissions error (EACCES): `npm install -g --prefix "$HOME/.npm-global" plasalid` and invoke plasalid via `$HOME/.npm-global/bin/plasalid` from then on.
- **First run:** `plasalid config --generate-key --json` (creates ~/.plasalid with the config, encrypted database, and data directory), then `plasalid doctor --json` — every check must be ok before continuing.
- **Statements in:** the data directory path is `dataDir` in `plasalid config show --json`. On a desktop, `plasalid data` opens it in the file manager; in a sandboxed/VM environment ask the human to attach/upload the statement PDF and write it into the data directory yourself.
- **Version check (registry-based):** compare `plasalid --version` with `npm view plasalid version`. If the installed CLI is behind the registry, upgrade — `npm install -g plasalid@latest` — and **never downgrade.** If the registry is unreachable, just proceed. This document can lag the CLI: `plasalid <noun> --help` outranks anything here wherever they disagree. On a terminal agent CLI, `plasalid doctor --json` reports installed-skill drift and `plasalid setup --force` refreshes the installed copy.

## Golden rules

- **Always pass `--json`.** NDJSON out: one object per line; streaming commands end with a `{"type":"summary",...}` line. Never scrape human tables.
- **Orient first:** `plasalid status --json` (config, database, ledger counts, net worth).
- **Never invent ids.** Account paths and `sf:` file / `tx:` transaction / `cn:` question / `m:` merchant ids all come from the harness — find them with `accounts match`, `merchants resolve`, or a `list`.
- **The harness never prompts.** Destructive commands need `--yes`; passwords go through `--password-stdin` or the vault.
- **Branch on the exit code:** 0 ok · 1 error · 2 usage · 3 not-ready (see Setup above, or run `plasalid doctor --json`) · 4 input required (password / `--yes` — ask the human, retry) · 5 not-found (wrong id — `list`/`match`) · 6 invalid · 7 partial (batch partly failed — inspect each `result`).
- **Errors** are one stderr object `{"error":{"code":"E_...","message":...,"hint":...}}`. Always read `hint`.
- **Read output is PII-redacted by default:** `[USER]`/`[CARD]`/`[ACCT]`… are mask placeholders, not data — never write them back. Verbatim only when the human asks: `plasalid transactions list --no-redact --json`.
- **Statement rows go through `plasalid ingest commit --file <sf:id> --input <path>`, never `transactions add` per row.** Batch every row into ONE commit: stage the NDJSON to a file, pass `--input`. That links rows to the source file and keeps re-ingest idempotent. `transactions add` is only for one-offs with no source document.

## When you are blocked

Degrade in this order when your *environment* fights you — never silently break the rules above.

- **Cannot Read the PDF** (Read tool has no PDF support): `plasalid ingest prepare <sf:id> --format png --dpi 200 --json` returns one PNG per page in `pages`; Read those. plasalid rasterizes with a bundled engine — no poppler or system dependency to install.
- **File writes blocked** (cannot stage the `--input` batch): write it in the current working directory first (usually allowed); if Write stays unavailable, ASK the human to enable it. LAST resort only: commit rows one-by-one with `plasalid transactions add --resolve`, then TELL the user this dropped idempotency and source-file linkage, so a re-run double-posts.
- **One `plasalid` command per Bash call.** Never chain with `&&`/`;`/`echo`, never heredoc JSON — allowlists and a brace guard block those. Move batches through `--input <file>`.

## Core concepts

- **Every entry is a _transaction_:** debits exactly one account, credits exactly one, by a single positive amount. Direction is WHICH account is debit vs credit — never a sign. Amounts are DECIMAL as printed (`135.00`); stored as integer minor units.
- **Normal balances:** `asset`/`expense` increase by a DEBIT; `liability`/`income`/`equity` by a CREDIT. Pick the two sides by which account each half grows.
- **Accounts** are colon-paths under `asset`, `liability`, `income`, `expense`, `equity` (e.g. `expense:food:groceries`). Reuse before creating: `plasalid accounts match --query <name> --json`. `accounts create` auto-creates missing parents (`created_parents` in output) — but `match` first to avoid a near-duplicate.

### Direction table

| Situation | Debit account | Credit account |
|---|---|---|
| Card purchase | `expense:<cat>` | `liability:credit_card:<x>` |
| Bank / debit-card spend | `expense:<cat>` | `asset:bank:<x>` |
| Bank fee | `expense:fees` | `asset:bank:<x>` |
| Cash purchase | `expense:<cat>` | `asset:cash` |
| Salary (net, simple) | `asset:bank:<x>` | `income:salary` |
| Interest earned | `asset:bank:<x>` | `income:interest` |
| Refund on card | `liability:credit_card:<x>` | `expense:<cat>` |
| Card payment (pay card from bank) | `liability:credit_card:<x>` | `asset:bank:<x>` |
| Cash withdrawal | `asset:cash` | `asset:bank:<x>` |
| Opening balance (asset) | `asset:<x>` | `equity:opening-balance` |
| Opening balance (card / liability) | `equity:opening-balance` | `liability:credit_card:<x>` |

- **Negative statement amounts mean money flowed BACK — never send a negative `amount`.** Use the matching table row at the absolute value: a `-165.00` card row is a refund; a large negative `Payment via <app>` row is the card payment.
- **Card rows print two dates (transaction + posted). Use the TRANSACTION date.**
- **Compound = shared-leg decomposition:** a split line becomes `linked` legs that commit atomically under one `group_id`. Find the ONE shared account; never invent clearing accounts. Payslip legs share `income:salary`; loan-payment legs share the paying `asset:bank:<x>`.
- **Idempotency (once, everywhere):** put `row_index` (0-based, per page) + `source_page` on every item and pass `--file <sf:id>`. The harness derives a stable id from file hash + page + row, so re-ingest is a `duplicate:true` no-op. Never renumber rows between retries.
- **Currency:** a transaction's two accounts must share one currency (derived from the accounts, never trusted from input). A cross-currency row is dropped as `currency_mismatch` — post it as two linked legs, one per currency, through `equity:conversion:<ccy>` (see the conversion-pair example under Ingest items).
- **Corrections:** wrong category -> `plasalid transactions recategorize`; wrong amount/currency -> `plasalid transactions delete` then re-ingest that row. A refund is a forward transaction (see table), never an edit.
- **Account ids are HINTS:** each side resolves exact -> fuzzy (>= 0.7) -> placeholder -> `expense:uncategorized`, committing and raising a question rather than blocking. Send `raw_descriptor` + `merchant:{canonical_name, alias}` so aliases are learned.

## Workflow: ingest statements

1. `plasalid ingest list --json` — each PDF's status (`new`/`pending`/`scanned`/`failed`), `file_id`, and whether it is encrypted.
2. `plasalid ingest prepare <pathOrId> --json` per new/pending file — `<pathOrId>` is the `path`/`rel_path` from `ingest list` or the `sf:` id (any cwd); returns `document`, the PDF to Read. Exit 4 = locked: get the password from the human, then `printf '%s' "$PW" | plasalid ingest prepare <id> --password-stdin --json`; store it with `plasalid vault add <pattern> --password-stdin`.
3. **Read the `document` PDF** and extract every row. (No PDF support? See **When you are blocked**.)
4. Build one NDJSON item per row (schema below): set `row_index` + `source_page`; send `raw_descriptor` + `merchant`.
5. Stage the batch to a file, then `plasalid ingest commit --file <sf:id> --input <path> --json`. Each line is a `result`; the `summary` has `batch_id`, `posted`, `duplicates`, `failed`. Exit 7 = some rows failed (a `duplicate` is a successful no-op).
6. **Opening balances:** when the header implies a pre-existing balance (prior card balance, account starting balance), POST it per the direction table (`equity:opening-balance`) then REPORT what you posted — do not ask first.
7. Card metadata from the header: `plasalid accounts update <liability:credit_card:x> --masked <digits> --points <n> --due-day <d> --statement-day <d> --json`. The masked number keeps its literal trailing digits (store `1234` as printed).
8. `plasalid questions list --batch <batch_id> --json` — resolve or defer (below).
9. `plasalid ingest done <sf:id> --agent claude-code --json` (failure: `plasalid ingest fail <sf:id> --error "<why>" --json`).

## Workflow: clear questions

`plasalid questions list --json`, then by `kind`:
- **similar_accounts** — near-duplicate; if the same: `plasalid accounts merge --from <id> --to <id> --yes --json`.
- **uncategorized** (placeholder created) — `plasalid transactions recategorize --set-account <id> --filter-account <placeholder> --json`, then `plasalid merchants set-default --merchant <id> --account <id> --json`.
- **unknown_merchant** — `plasalid merchants upsert --name <canonical> --alias <descriptor> --json`.
- **currency_mismatch** — re-post as a linked conversion pair.
- Answer: `plasalid questions answer <id> --answer "<text>" --json` (`--also <id,id>` closes siblings); `plasalid questions defer <id> --days <n> --json` when unknowable.
- Durable user preference/rule? `plasalid notes add --content "..." --category preference --json` (check `plasalid notes list --json` first).

## Other workflows

- **Manual entry** — a one-off the user dictates ("300 baht lunch, cash"), NOT statement rows: find ids with `plasalid accounts match --query <name> --json`, then `plasalid transactions add --debit-account expense:food --credit-account asset:cash --amount 300 --json`. Add `--resolve` to fuzzy-resolve hint ids and raise questions instead of failing.
- **Reporting** — net worth: `plasalid status --json` (`net_worth`). Also `plasalid report --from <date> --to <date> --json`; `plasalid accounts show <id> --json` and `plasalid accounts tree --json` (per-account `balance`/`debits_posted`/`credits_posted`, rollups); `plasalid transactions list --json` (+ `plasalid transactions show <tx:id> --json`); `plasalid transactions dedupe --json`.
- **Source files** — inspect or drop the tracked statement files behind the ledger: `plasalid files list --json`, `plasalid files show <sf:id> --json`, `plasalid files drop <sf:id> --yes --json` (cascades its transactions + questions).

## Ingest items

One standalone NDJSON item; a compound item swaps the top-level account/amount fields for a `linked:[...]` array sharing one group (payslip, loan, FX). Required per standalone item: `date`, `description`, `debit_account`, `credit_account`, `amount` (> 0); account ids are HINTS. Full flags and subcommands: `plasalid <noun> --help`.

```json
{"date":"2025-03-14","description":"Starbucks Siam Paragon","raw_descriptor":"POS 1234 STARBUCKS SIAMPARAGON","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS SIAMPARAGON"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
```

| field | type | req | notes |
|---|---|---|---|
| `date` | string | yes | ISO `YYYY-MM-DD`; Buddhist-Era year - 543. |
| `description` | string | yes | Human summary of the row. |
| `debit_account` | string | yes\* | Account to DEBIT; a HINT. Alias `debit_account_id`. |
| `credit_account` | string | yes\* | Account to CREDIT; a HINT. Alias `credit_account_id`. |
| `amount` | number | yes\* | Decimal as printed, > 0, in the accounts' currency; stored as minor units. |
| `linked` | array | no | Compound: OMIT top-level `debit_account`/`credit_account`/`amount`; give legs `{debit_account, credit_account, amount, description?, currency?, code?}` committing atomically under one shared `group_id`. |
| `currency` | string | no | Hint only; default `THB`. Stored currency derives from the accounts; a differing hint is ignored (`transactions add --resolve` reports `currency_overridden`). |
| `code` | string | no | External reference, carried onto the transaction. |
| `raw_descriptor` | string | no | Verbatim bank text; drives merchant-alias learning. |
| `source_page` | number | no | Page the row came from; part of the derived id — set whenever `row_index` is set. |
| `row_index` | number | no | 0-based row position on the page; with `source_page` + `--file` makes re-ingest idempotent. |
| `source_file_id` | string | no | `sf:` id; falls back to `--file`. Supplies the file hash used for id derivation. |
| `merchant` | object | no | `{canonical_name (req), alias?, default_account_id?}`; upserted, alias learned. |
| `merchant_id` | string | no | Pre-resolved merchant id; overrides `merchant`. Unknown id raises `unknown_merchant`. |
| `id` | string | no | Explicit transaction id; ignored when a deterministic id can be derived. |
| `group_id` | string | no | Explicit compound group id; derived (`tg:`) from file hash + page + row when omitted. |

\* Required for a standalone item; supplied per-leg inside `linked`. Put shared fields (`date`, `description`, `raw_descriptor`, `source_page`, `row_index`, `merchant`) on the compound envelope, not the legs.

Compound / `linked` payslip (gross 60000 = net 50000 + tax 8000 + social security 2000, every leg crediting the shared `income:salary`):

```json
{"date":"2025-01-25","description":"Acme payroll January","source_page":1,"row_index":0,"linked":[{"debit_account":"asset:bank:kbank","credit_account":"income:salary","amount":50000.00,"description":"Net pay"},{"debit_account":"expense:tax","credit_account":"income:salary","amount":8000.00,"description":"Withholding tax"},{"debit_account":"expense:social-security","credit_account":"income:salary","amount":2000.00,"description":"Social security"}]}
```

Cross-currency as a conversion pair (36000 THB out, 1000 USD in; each leg homogeneous, linked through `equity:conversion:<ccy>`):

```json
{"date":"2025-04-02","description":"THB to USD transaction","source_page":3,"row_index":0,"linked":[{"debit_account":"equity:conversion:thb","credit_account":"asset:bank:kbank","amount":36000.00,"currency":"THB","description":"THB out"},{"debit_account":"asset:bank:wise-usd","credit_account":"equity:conversion:usd","amount":1000.00,"currency":"USD","description":"USD in"}]}
```

### Commit output (NDJSON)

`plasalid ingest commit` emits one `result` per input item, then a terminal `summary`.

Standalone success:

```json
{"type":"result","index":0,"ok":true,"transaction_id":"tx:...","duplicate":false,"raised_questions":1,"merchant":{"how":"linked","merchant_id":"m:..."},"sides":[{"side":"debit","requested":"expense:food:coffee","resolved":"expense:food:coffee","how":"exact"},{"side":"credit","requested":"asset:bank:kbank","resolved":"asset:bank:kbank","how":"exact"}]}
```

Compound success — `group_id` + `legs` replace `transaction_id` + `sides`:

```json
{"type":"result","index":1,"ok":true,"group_id":"tg:...","legs":[{"transaction_id":"tx:...","duplicate":false}],"duplicate":false,"raised_questions":0,"merchant":{"how":"none"}}
```

Failure — the item is dropped and a question is raised; `reason` is `dirty_input` or `currency_mismatch`:

```json
{"type":"result","index":2,"ok":false,"reason":"dirty_input","message":"...","raised_questions":1}
```

Summary — `batch_id` is the scan id questions attach to; exit 7 when `failed` > 0; duplicates are successes, counted separately:

```json
{"type":"summary","batch_id":"sc:...","posted":3,"duplicates":1,"failed":1,"raised_questions":2}
```

- side `how`: `exact` | `fuzzy_matched` | `placeholder_created` | `uncategorized_fallback` (`requested` = your hint, `resolved` = what posted).
- `merchant.how`: `none` | `unknown` (id missing) | `linked` (`merchant_id` present).
- `duplicate:true` means the transaction already existed (idempotent re-commit) — a success, never a failure.
- `raised_questions` counts the questions that item opened.

### Prepare output

`plasalid ingest prepare <pathOrId> --json` returns `document` (the PDF to Read directly) and one entry per page in `pages`:

```json
{"file_id":"sf:...","format":"pdf","document":"/abs/statement.pdf","page_count":3,"pages":[{"page":0,"path":"/abs/statement.pdf"}]}
```

The PNG fallback (`--format png --dpi 200`) sets `"format":"png"`, echoes `dpi`, and lists one PNG per page in `pages`.

## Taxonomy

Account roots + suggested subtypes — build colon-paths under each root:

- **asset** — bank, cash, wallet, prepaid_card, brokerage, crypto, receivable
- **liability** — credit_card, home_loan, auto_loan, personal_loan, student_loan, revolving, deferred_income
- **income** — salary, bonus, freelance, interest, dividend, refund, other
- **expense** — food, transport, utilities, rent, housing, healthcare, entertainment, shopping, subscriptions, education, travel, fees_and_interest, tax, insurance, other
- **equity** — opening-balance, conversion:<ccy> (opening balances and FX legs)

Account-forming institution codes are stable handles — use each as the account leaf (asset:bank:kbank, liability:credit_card:ktc). Insurers, government offices, telcos and utilities are NOT accounts; add them as merchants via merchants upsert, never account leaves.

### Thai institution codes

**Banks** · `KBANK` Kasikornbank · `SCB` Siam Commercial Bank · `BBL` Bangkok Bank · `KTB` Krungthai Bank · `BAY` Krungsri · `TTB` TMBThanachart · `UOB-TH` UOB Thailand · `CIMB-TH` CIMB Thai · `GHB` Government Housing Bank · `GSB` Government Savings Bank · `LH-BANK` Land and Houses Bank · `KKP` Kiatnakin Phatra · `TISCO` TISCO Bank · `IBT` Islamic Bank of Thailand · `ICBC-TH` ICBC (Thai) · `BAAC` Agri. Cooperatives Bank

**Card issuers** · `KTC` Krungthai Card · `AEON` AEON Thana Sinsap · `FIRSTCHOICE` Krungsri First Choice · `CITI-TH` Citibank Thailand (historical) · `AMEX-TH` American Express · `CARDX` CardX · `DINERS` Diners Club Thailand · `UOB-TH` UOB Thailand cards

**E-wallets** · `TRUEMONEY` TrueMoney Wallet · `LINEPAY` Rabbit LINE Pay · `SHOPEEPAY` ShopeePay · `GRABPAY` GrabPay · `DOLFIN` Dolfin Wallet · `MPAY` mPay · `PAOTANG` Paotang

**Brokers** · `INNOVESTX` InnovestX · `BLS` Bualuang Sec. · `KS` Kasikorn Sec. · `KGI-TH` KGI Sec. · `MAYBANK-SEC` Maybank Sec. · `ASP` Asia Plus Sec. · `TISCO-SEC` TISCO Sec. · `KSS` Krungsri Sec. · `KKPS` Kiatnakin Phatra Sec. · `LH-SEC` Land & Houses Sec. · `FINANSIA` Finansia Syrus · `YUANTA-TH` Yuanta Sec. · `DBSVICKERS` DBS Vickers · `KTBST` Krungthai Xspring

**Crypto exchanges** · `BITKUB` Bitkub · `UPBIT-TH` Upbit Thailand · `ORBIX` Orbix Trade · `GULF-BINANCE` Binance Thailand · `KUCOIN-TH` KuCoin Thailand · `WAANX` WaanX · `TDX` Thai Digital Assets Exchange · `GMO-Z-EX` Z.com EX · `ZIPMEX` Zipmex (defunct)
