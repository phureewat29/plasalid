<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>The local-first data layer for personal finance</strong>
</p>

<p align="center">
  Turn the financial documents into a queryable dataset.
</p>


<br />

Plasalid turns the financial documents you already receive — bank statements, credit-card statements — into a queryable, double-entry database on your own machine. Drop PDFs into a directory, run `plasalid scan`, and Plasalid extracts each file into balanced journal entries. From there, query it, chat with it, or hand it off to other AI tools as a data harness to build on.

Plasalid exists because in markets like Thailand there's no Plaid: financial data is locked inside banks and government agencies. Fintech can't move forward when the underlying data layer is closed — and AI agents can't help you with money they can't see. Until that infrastructure opens up, Plasalid lets individuals be their own aggregator: locally, from the artifacts they already control, and feeds the result to whatever AI tools they want.

## Features

### A data harness AI can plug into

- **The missing aggregator** — In markets without Plaid, there's no bank API that easy to access. Plasalid turns the documents you already receive into a database that machine can read, so the data layer stops being the blocker.
- **Composable substrate** — Plasalid's local SQLite is plain, queryable double-entry data. Any tool that can read SQLite — Claude Code, MCP servers, your own scripts, dashboards — can build automations, alerts, exporters, or personalized analyses on top, with no further integration work.
- **No vendor lock, no rate limits** — Standard accounts and journal lines, your encryption key, your machine. Nothing to revoke, throttle, or paywall.

### Drop documents in, get structured data out

- **Encrypted PDFs handled inline** — Statement password-protected? Plasalid prompts you once, then remembers the password (encrypted at rest) under a filename pattern so the next month's statement unlocks silently.
- **Asks instead of guessing** — Ambiguous row? The scanner pauses and prompts you.
- **Idempotent scan** — Files are hashed; re-running `plasalid scan` skips what it already scanned. `--force` cascade-deletes prior records before re-scanning.
- **Learns your statements** — Per-bank scanning hints persist across runs (the AI saves them in a local memory table) so each new statement scans more accurately than the last.

### Correctness, not vibes

- **Double-entry bookkeeping** — Every transaction balances enforced by standard double-entry accounting.
- **Account metadata preserved** — Bank, masked number, statement day, due day, points.
- **Dates normalized** — ISO Gregorian; Buddhist-Era dates converted automatically.
- **Reconcile pass** — `plasalid reconcile` surfaces duplicate entries, similar accounts, and unused accounts; merges, renames, and deletes happen only after explicit confirmation. `--dry-run` previews without writing.

### Your data never leaves your machine

- **Encrypted local database** — All data stays on your machine in an AES-256 encrypted SQLite database.
- **PII masking** — Names, national IDs, phones, full account/card numbers scrubbed before anything reaches the AI.
- **No telemetry. No analytics.** Only outbound traffic is to your configured AI provider.


## Install

```bash
npm install -g plasalid
```

Requires Node ≥ 18.

## Quick Start

```bash
plasalid setup
```

Then:

1. Drop any PDFs anywhere under `~/.plasalid/data/`. Subfolders are allowed but not interpreted — the AI infers account type from the document.
2. Run `plasalid scan` and answer any clarifying questions inline.
3. Run `plasalid` to chat with what was scanned.

Other day-to-day commands:

- `plasalid scan <regex>` — only scan files whose path matches the regex.
- `plasalid scan <regex> --force` — re-scan matching files (replaces prior records).
- `plasalid reconcile --dry-run` — periodically surface duplicate entries and similar accounts; re-run without `--dry-run` to apply fixes interactively.
- `plasalid undo <regex>` — delete scanned files matching the regex and every journal entry derived from them.

## Commands

Run `plasalid --help` to see all available commands.

| Command | Description |
|---------|-------------|
| `plasalid` | Interactive TUI chat with your local data |
| `plasalid setup` | Configure API key, encryption, and data directory |
| `plasalid data` | Open the Plasalid data folder in your OS file explorer |
| `plasalid accounts` | Show the chart of accounts with balances |
| `plasalid status` | Net worth and this-month income/expense totals |
| `plasalid transactions [--account] [--from] [--to] [--query] [--limit]` | List journal lines, optionally filtered |
| `plasalid scan [regex] [--force]` | Scan new PDFs; `--force` cascade-deletes prior records before re-scanning |
| `plasalid reconcile [--account] [--from] [--to] [--dry-run]` | Review the existing journal: surface duplicates, similar accounts, and unused accounts; apply fixes after confirmation |
| `plasalid undo <regex>` | Delete scanned files matching `<regex>` and their journal entries |

## How It Works

```
  Bank statements · Credit-card statements
                  │
             (drop PDFs)
                  │
       ┌──────────▼──────────┐
       │  ~/.plasalid/data/  │
       └──────────┬──────────┘
                  │
             plasalid scan
                  │
       Claude API (PII-redacted)
                  │
       ┌──────────▼──────────┐
       │     Encrypted DB    │◀──── plasalid reconcile
       └──────────┬──────────┘       
                  │                   
        plasalid · chat               
```

Two outbound calls: the AI provider during scan, and the AI provider during chat. Both are PII-redacted. Your financial data is never stored off your machine. No telemetry. No analytics.

## Security & Privacy

- All financial data stored locally in `~/.plasalid/db.sqlite`
- Database encrypted with AES-256 (libsql)
- Config file stored with `0600` permissions
- PII redacted before sending to any AI provider
- Encrypted-PDF passwords are AES-GCM-encrypted inside `db.sqlite` under a filename pattern; never written to disk in plaintext.
- Only outbound traffic is to your configured AI provider

## Configuration

Plasalid stores everything in `~/.plasalid/`:

```
~/.plasalid/
  config.json          # API keys and preferences (0600 permissions)
  context.md           # Persistent personal context
  db.sqlite            # Encrypted SQLite database
  data/                # Drop any PDFs here (subfolders allowed; AI classifies)
```

`db.sqlite` holds the journal, chart of accounts, scan history, persisted long-term memories, and AES-GCM-encrypted PDF passwords keyed by filename pattern. Everything is wrapped in libsql's AES-256 page encryption.

### Environment Variables

```bash
ANTHROPIC_API_KEY=            # Anthropic API key (required)
PLASALID_MODEL=               # Default: claude-sonnet-4-6
PLASALID_DB_ENCRYPTION_KEY=   # DB encryption passphrase
PLASALID_DB_PATH=             # Default: ~/.plasalid/db.sqlite
PLASALID_DATA_DIR=            # Default: ~/.plasalid/data
```

## Contributing

```bash
git clone https://github.com/phureewat29/plasalid
cd plasalid
npm install
npm run build
npm link # makes 'plasalid' available globally
```
