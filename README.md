<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>Talk to your money</strong>
</p>

<p align="center">
  A local-first AI that reads every line of your transactions and coaches you the best move.
</p>


<br />

Plasalid lets you actually *talk* to your money. Drop your bank and credit-card statement PDFs into a folder. Plasalid scans every transaction, every balance, every late fee into a double-entry database on your own machine. Then you chat with it — an AI that's read every line and tells you, sharply and proactively, what's going on. Local, private, yours.

Plasalid exists because in markets like Thailand there's no Plaid. In the US, a single API gives apps a live view of every balance and transaction across all your accounts — one complete picture of your money. In Thailand, knowing where you stand means logging into five different bank apps in sequence one by one. Most people just don't bother. And most people can't afford a financial advisor to do it for them either. The result is people fly blind with their own money — and grow careless with it. Bills slip past, small leaks compound, and the first real look tends to come after something has already gone wrong.

In addition, personal finance isn't taught well in Thai schools. Fee-based advisors are out of reach for most households. The loudest "advice" channels are bank salespeople pitching their employer's products. The result: over **5 million Thais** are already flagged as non-performing borrowers, and a generation that wants to manage money better has nowhere accessible to learn how. Plasalid's bet is that capable AI changes that. The same intelligence that reads your statements can explain what the numbers mean. It flags what's about to go wrong. It coaches you through real decisions — debt, budget, savings.

And when survival isn't the question anymore, the same Plasalid can scales up with you. Saving for a trip. Building an emergency fund. Choosing investments. Planning a down payment or retirement. Working toward the freedom to walk away from a bad job. From getting out of debt to financial freedom, Plasalid grows with you.

## Features

### Your personal money coach

- **Sees every balance, every transaction** — Plasalid's chat reads from your bank and credit-card statements, not generic categories. "Where did ฿14k go in March?" gets a specific answer.
- **Sharp and proactive** — Leads with the insight, not the breakdown. Flags concerning patterns (overdraft trajectory, unusual spending, payments due soon) even if you didn't ask.
- **Has a point of view** — When you ask "what should I do?", you get a recommendation, not a list of options.
- **Remembers what matters** — Persists biographical context (family, employer, goals) and per-statement scanning hints across sessions, so each conversation starts smarter than the last.

### A data harness AI can plug into

- **The missing aggregator** — In markets without Plaid, there's no bank API that easy to access. Plasalid turns the documents you already receive into a database that machine can read, so the data layer stops being the blocker.
- **Composable substrate** — Plasalid's local SQLite is plain, queryable double-entry data. Any tool that can read SQLite — Claude Code, MCP servers, your own scripts, dashboards — can build automations, alerts, exporters, or personalized analyses on top, with no further integration work.
- **No vendor lock, no rate limits** — Standard accounts and journal lines, your encryption key, your machine. Nothing to revoke, throttle, or paywall.
- **BYO model** — Pick Anthropic (Claude) or any OpenAI-compatible server (Ollama, OpenAI, LM Studio, vLLM, …) at setup time. Local models keep the conversation 100% on your machine.

### Drop documents in, get structured data out

- **Encrypted PDFs handled inline** — Statement password-protected? Plasalid prompts you once, then remembers the password (encrypted at rest) under a filename pattern so the next month's statement unlocks silently.
- **Asks instead of guessing** — Ambiguous row? The scanner pauses and prompts you.
- **Idempotent scan** — Files are hashed; re-running `plasalid scan` skips what it already scanned. `--force` cascade-deletes prior records before re-scanning.
- **Learns your statements** — Per-bank scanning hints persist across runs (the AI saves them in a local memory table) so each new statement scans more accurately than the last.

### Correctness, not vibes

- **Double-entry bookkeeping** — Every transaction balances enforced by standard double-entry accounting.
- **Account metadata preserved** — Bank, masked number, statement day, due day, points.
- **Dates normalized** — ISO Gregorian; Localization dates converted automatically.
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

1. Run `plasalid open` to pop open your data folder in Finder/Explorer, then drag in any bank or credit-card statement PDF you've got. **One file is enough to start** — Plasalid will already give you useful answers about that account. More files make the picture richer.
2. Run `plasalid scan` and answer any clarifying questions inline.
3. Run `plasalid` to chat with what was scanned.

Other day-to-day commands:

- `plasalid scan <regex>` — only scan files whose path matches the regex.
- `plasalid scan <regex> --force` — re-scan matching files (replaces prior records).
- `plasalid reconcile --dry-run` — periodically surface duplicate entries and similar accounts; re-run without `--dry-run` to apply fixes interactively.
- `plasalid revert <regex>` — delete scanned files matching the regex and every journal entry derived from them.

## Commands

Run `plasalid --help` to see all available commands.

```bash
plasalid                            # Interactive TUI chat with your local data
plasalid setup                      # Configure API key, encryption, and data directory
plasalid data                       # Open the Plasalid data folder in your OS file explorer
plasalid accounts                   # Show the chart of accounts with balances
plasalid status                     # Net worth and this-month income/expense totals
plasalid transactions               # List journal lines (filter by --account, --from, --to, --query, --limit)
plasalid scan [regex] [--force]     # Scan new PDFs; --force cascade-deletes prior records before re-scanning
plasalid revert <regex>             # Delete scanned files matching <regex> and their journal entries
plasalid reconcile [--dry-run]      # Review the journal: duplicates, similar accounts, unused accounts (--account, --from, --to also accepted)
```

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
ANTHROPIC_API_KEY=            # Anthropic API key (required when provider is anthropic)
PLASALID_MODEL=               # Model name; default for Anthropic: claude-sonnet-4-6
PLASALID_PROVIDER=            # anthropic | openai-compatible. Default: anthropic
OPENAI_COMPATIBLE_BASE_URL=   # e.g. http://localhost:11434/v1 (Ollama)
OPENAI_COMPATIBLE_API_KEY=    # API key for the OpenAI-compatible server (often unused)
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

## License

Plasalid is released under the [Apache License 2.0 with the Commons Clause](./LICENSE).

You're free to use, copy, modify, distribute, and fork it. The Commons Clause adds one restriction: **you may not Sell the Software** — that is, you may not provide a paid product or service whose value derives entirely or substantially from Plasalid's functionality (including paid hosting or support). For commercial-resale rights, contact the copyright holder to negotiate a separate license.
