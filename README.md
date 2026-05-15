<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>A local-first Plaid for your bank statements</strong>
</p>

<p align="center">
  Turn the PDFs you already receive into a structured, AI-readable journal — on your own machine.
</p>


<br />

In markets like Thailand there's no Plaid: no public API that gives apps a unified view of every account, no easy way to assemble a complete picture of your money. Knowing where you stand means logging into five bank apps one by one — and most people just don't bother. Plasalid is the missing layer: drop your bank and credit-card statement PDFs into a folder and Plasalid parses every transaction, balance, and fee into a double-entry SQLite database that lives on your machine. One source of truth for every account, ready for any AI to read.

Plasalid ships with a built-in chat so you can start asking questions right away, but the data layer is the product. A local MCP / API server is coming next, so any AI tool — Claude Desktop, your own scripts, dashboards, automations — can read the same journal without further integration. Local, private, yours.

## Features

Plasalid is a chain of three stages: **Scan → Review → Chat.** Today's chat is one consumer of the journal; the same data will power a local MCP / API server next.

### Scan — parse without blocking

- **Drop PDFs in, get a balanced journal out.** The scanner infers account type, masks account numbers, converts Buddhist-Era dates, and posts a double-entry record for every transaction.
- **Never pauses to ask you.** Ambiguous rows post best-guess entries with a structured *concern* attached; unparseable rows are skipped, not guessed. A missing row is better than a wrong row — review clears them up later.
- **Encrypted PDFs handled inline.** Statement password-protected? Plasalid prompts you once, remembers the password (AES-GCM at rest) under a filename pattern, and unlocks next month's statement silently.

### Review — see the whole picture

- **Connects related transactions.** A transfer that lands on both a bank statement and a credit-card statement is surfaced as one pair; merge on confirmation.
- **Recurrences as first-class data.** Spotify, salary, rent get their own `recurrences` rows with cadence (weekly / biweekly / monthly / annually) and next-expected dates, linked back to every member entry. Not a UI category — a fact about your money the next AI tool can read.
- **Step-by-step clarification.** Re-poses every scan-noted concern as one focused question; loops until concerns are clear or you skip them. `--dry-run` previews everything; writes only after you confirm.

### Chat — ask questions about your data

- **Reads your real journal lines.** Not generic categories. "Where did ฿14k go in March?" gets an answer drawn from actual entries, with figures, dates, and account names cited; nothing invented.
- **One of many possible consumers.** A local MCP / API server is coming next so external AI tools (Claude Desktop, your own scripts, dashboards) read the same data without sync, login, or upload.

### Built to be plugged into

- **Local-first.** AES-256 encrypted SQLite on your machine. No cloud sync, no third-party aggregator, no upstream account to trust.
- **Standard double-entry.** No proprietary schema; any tool that speaks SQL can plug in. No vendor lock, no rate limits, no paywall.
- **PII redacted on the way out.** Names, national IDs, phone numbers, and full account/card numbers are scrubbed before any prompt leaves your machine.
- **BYO model.** Pick Anthropic (Claude) or any OpenAI-compatible server (Ollama, OpenAI, LM Studio, vLLM, …) at setup. Local models keep everything 100% on your machine.


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
2. Run `plasalid scan` — it parses your PDFs end-to-end without stopping.
3. Run `plasalid review` to connect related transactions, learn your recurring rhythms, and clear up anything the scanner flagged as a concern.
4. Run `plasalid` to chat with what was scanned.

Other day-to-day commands:

- `plasalid scan <regex>` — only scan files whose path matches the regex.
- `plasalid scan <regex> --force` — re-scan matching files (replaces prior records).
- `plasalid review --dry-run` — preview the picture (correlated transactions, recurrences, open concerns) without writing; re-run without `--dry-run` to step through fixes interactively.
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
plasalid review [--dry-run]         # Connect related transactions, learn recurring rhythms, resolve open concerns (--account, --from, --to also accepted)
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
       │     Encrypted DB    │◀──── plasalid review
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

`db.sqlite` holds the journal, chart of accounts, scan history, open concerns awaiting review, recurring transactions (Spotify, salary, rent — recognized during review and linked from each member journal entry), persisted long-term memories, and AES-GCM-encrypted PDF passwords keyed by filename pattern. Everything is wrapped in libsql's AES-256 page encryption.

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
