<p align="center">
  <img src="https://i.ibb.co/fdkHzmZk/plasalid-logo.png" alt="Plasalid" width="108" />
</p>

<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>The Harness Layer for Personal Finance</strong>
</p>

<p align="center">
    Turn your scattered financial documents into structured, insightful, AI-readable context.
</p>


<br />

In US and Europe, the most of financial apps is likely powered by a hidden aggregators engine like Plaid. You can link your bank accounts once and see your entire financial life in one place. But for most of the world, Thailand included, that infrastructure simply does not exist.

Your data is locked in bank silos. Tracking your net worth means logging into half a dozen apps and crunching the numbers manually. This fragmentation creates massive blind spots. Subscriptions are forgotten, strange charges go unnoticed, and planning for big financial goals becomes a guessing game.

Plasalid is a local data harness built to fix this. Think of it as a personal financial harness.

You drop your raw financial documents (bank statements, credit card bills, payslips) straight into a folder on your machine. Plasalid parses those files and extracts every transaction, balance, and holding. It transforms a messy pile of PDFs into a clean, double-entry ledger. You only have to build this foundation once. The result is an open, structured backend for your finances, ready to plug into any tool you want.

To show you the power of this harness out of the box, Plasalid includes a built-in AI agent. Because your ledger is fully structured, you can actually talk to your money. Ask a question like "Which subscriptions are still active?" or "What did I spend on food last month?". You get exact numbers pulled directly from your records, not estimates or AI hallucinations.

We also built strict boundaries around your privacy. The database is encrypted locally. Plasalid automatically strips out all PII before sending data to an external API. This mean if you swap in a local AI model, your setup runs can stay 100% private and offline.

<p align="center">
  <img src=".github/plasalid-demo.png" alt="demo" width="100%" />
</p>

## Features

### Unified ledger from any financial document

* **Drop PDFs, get a complete ledger.** Just drag in your bank statements, credit card bills, payslips, or brokerage summaries. Plasalid uses AI to extract every transaction, balance, and holding straight into a double-entry database.
* **No aggregators or per-bank logins.** The big picture builds itself from the documents you already get every month. Zero manual data entry and no fragile bank connectors to maintain.

### Built-in AI agent that queries your real data

* **Ask in plain English.** Type questions like "Which subscriptions are still active?", "Where did my money go last month?", or "What is my net worth right now?".
* **Answers from actual records.** The dates, merchants, and numbers are pulled directly from your ledger. You get hard facts. Nothing is estimated and nothing is invented.

### Local-first, private, and open as a harness

* **Everything runs on your machine.** Your ledger is stored in an AES-256 encrypted SQLite database. There are no cloud aggregators or upstream accounts. No third party ever touches your data.
* **PII redacted by default.** Your name, phone numbers, and full account details are completely scrubbed before any prompt leaves your hardware.
* **Bring your own AI.** Choose Anthropic or any OpenAI-compatible local model during setup. If you run a local model, your setup stays 100% private and offline.
* **A harness layer for AI agents.** The structured ledger acts as your baseline data layer. It is designed to be open and ready for any external tools you want to plug in.


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
3. Run `plasalid clarify` to connect related transactions, learn your recurring rhythms, and clear up anything the scanner flagged as a question.
4. Run `plasalid` to chat with what was scanned.

Other day-to-day commands:

- `plasalid scan <regex>` — only scan files whose path matches the regex.
- `plasalid scan <regex> --force` — re-scan matching files (replaces prior records).
- `plasalid clarify` — walk every open question one at a time and apply your decision (categorize, merge duplicates, link recurrences, etc). 

## Commands

Run `plasalid --help` to see all available commands.

```bash
plasalid                            # Interactive chat with your data
plasalid setup                      # Configure API key, encryption, and data directory
plasalid data                       # Open the Plasalid data folder in your file explorer
plasalid accounts                   # Show the chart of accounts with balances
plasalid transactions               # List transactions and their postings (filter by --account, --from, --to, --query, --limit)
plasalid status                     # Net worth and this-month income/expense totals
plasalid record [utterance]         # Add a manual transaction, account, balance, or merchant from a plain-language line
plasalid scan [regex] [--force]     # Scan new PDFs; --force cascade-deletes prior records before re-scanning
plasalid clarify                    # Walk every open question and apply your decision
```

## How It Works

```
  Bank · Card · Payslip · Brokerage · Transfer · Receipt
                  │
             (drop PDFs)
                  │
       ┌──────────▼──────────┐
       │  ~/.plasalid/data/  │
       └──────────┬──────────┘
                  │
    plasalid scan / plasalid record
                  │
       AI provider (PII-redacted)
                  │
       ┌──────────▼──────────┐
       │     Encrypted DB    │◀──── plasalid clarify
       └──────────┬──────────┘       
                  │                   
               plasalid               
```

Two outbound calls: the AI provider during scan, and the AI provider during chat. Both are PII-redacted. Your financial data is never stored off your machine. The same encrypted ledger is open to external AI agents through a local MCP / API server (coming next). No telemetry. No analytics.

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

`db.sqlite` holds the three-layer ledger (hierarchical accounts, deduplicated merchants with categories, transactions and postings), scan history, open questions awaiting clarify, recurring transactions (Spotify, salary, rent — recognized during clarify transaction), persisted long-term memories, and AES-GCM-encrypted passwords. Everything is wrapped in libsql's AES-256 page encryption.

### Environment Variables

```bash
ANTHROPIC_API_KEY=            # Anthropic API key (required when provider is anthropic)
PLASALID_MODEL=               # Model name; default for Anthropic: claude-sonnet-4-6
PLASALID_PROVIDER=            # anthropic | openai-compatible. default: anthropic
OPENAI_COMPATIBLE_BASE_URL=   # e.g. http://localhost:11434/v1 (ollama)
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
