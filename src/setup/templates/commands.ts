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
