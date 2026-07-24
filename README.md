<p align="center">
  <img src="https://i.ibb.co/fdkHzmZk/plasalid-logo.png" alt="Plasalid" width="108" />
</p>

<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>The Harness Layer for Personal Finance</strong>
</p>

<p align="center">
    A deterministic CLI harness that lets any agent turn scattered financial PDFs into a structured, auditable ledger.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/plasalid"><img src="https://img.shields.io/npm/v/plasalid.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/plasalid"><img src="https://img.shields.io/npm/dt/plasalid.svg" alt="npm total downloads" /></a>
</p>

<br />

In the US and Europe, aggregators like Plaid link your bank accounts once and show your whole financial life in one place. Most of the world, Thailand included, has no such infrastructure.

Your data sits scattered across separate bank apps. Tracking your net worth means logging into half a dozen of them and doing the math by hand. You forget subscriptions, miss strange charges, and can't plan big financial goals with any confidence.

Plasalid works from the documents you already get every month: bank statements, credit card bills, payslips. Drop them into a folder on your machine, and any agent you already use, a coding agent in your terminal or an assistant in a chat app that accepts skills, can pick up one skill file and take it from there. It keeps your books on a deterministic, auditable, double-entry ledger, encrypted on your machine.

Plasalid itself has no built-in AI model, no API key to configure, and no chat window. It is the harness underneath. Setting an agent up takes one step: see [Install Plasalid for your AI](#install-plasalid-for-your-ai).

## Features

### Unified ledger from any financial document

* `plasalid ingest list` discovers new statements. `plasalid ingest prepare` hands back a readable statement document, unlocking encrypted PDFs via a stored password vault. `plasalid ingest commit` posts the transactions an agent extracted straight into a double-entry ledger.
* No aggregators, no per-bank logins. Plasalid works from the documents you already get every month, with no manual data entry and no bank connectors to maintain.

### A local-first, encrypted, and inspectable financial harness

* Every step of the pipeline (accounts, transactions, merchants) is also a plain CLI command. Run it by hand, script it, or hand the whole thing to an agent.
* Plasalid stores your ledger in an AES-256 encrypted SQLite database (via libsql), entirely on your machine. No cloud aggregators, no upstream accounts. Nothing leaves your machine unless you send it yourself.
* Read commands that touch free text (`status`, `accounts list`, `transactions list`, `transactions show`, `questions list`) mask PII automatically before output reaches an agent or a paste buffer. Pass `--no-redact` for verbatim text.
* Plasalid writes nothing to disk but your own data, under `~/.plasalid/`. No telemetry, no analytics.

## Install

```bash
npm install -g plasalid
```

Requires Node ≥ 18.

## Quick Start

```bash
plasalid config --generate-key
```

This creates `~/.plasalid/` (config, encrypted database, data directory) and generates a database encryption key for you.

Then drop some statements in:

```bash
plasalid data          # opens ~/.plasalid/data in Finder/Explorer, drag PDFs in
```

## Install Plasalid for your AI

The entire skill is one markdown file checked into this repo: [`skills/SKILL.md`](./skills/SKILL.md). What you see at that link is exactly what every agent gets, no build step involved; `plasalid setup --print` prints the same bytes.

**Terminal and coding agents** (Claude Code, Codex, Cursor, and the like): install it with the [Skills CLI](https://github.com/vercel-labs/skills), which finds this repository's skill automatically:

```bash
npx skills add phureewat29/plasalid
```

Add `--global` to install it once for every project instead of just the current one. To stay offline, use the built-in alternative: `plasalid setup` writes the same file to `./.claude/skills/plasalid` (`plasalid setup --codex` maintains a plasalid block in `AGENTS.md` instead).

**Chat apps without a package installer** (Claude Desktop, Kimi, and the like): paste this prompt in:

```
Read https://raw.githubusercontent.com/phureewat29/plasalid/main/skills/SKILL.md and follow it as your instructions whenever I ask about my finances.
```

Once the skill is installed, give your agent a real task:

1. Start with the statements you have waiting: *"Ingest my new statements."* It discovers new files, prepares and reads each one, commits the transactions it finds, and raises a question for anything it can't resolve on its own.
2. Clear whatever it flagged: *"Show me anything you weren't sure about, and let's resolve it."* It walks you through open questions, such as an unrecognized merchant or an ambiguous account match, one at a time.
3. With the ledger current, ask for the payoff: *"What's my net worth, and where did most of my spending go last month?"* It reads the answer straight from the ledger.

## Example Agent with Plasalid

**Corgi Agent** is a demo personal-finance tracker built on Plasalid. It ships a sample, password-protected credit-card statement: the agent unlocks it through the vault, reads it, posts every transaction to the ledger, and answers spending questions. One `claude -p` session, continued across three turns and rendered in a live terminal UI, drives the whole demo in an isolated workspace.

```bash
cd examples/corgi-agent
npm install
npm start
```

Requires the `claude` CLI (or run `npm start -- --skip-claude` for a plumbing-only check without it); nothing touches your real data.

## The Agent Workflow

Every row becomes a *transaction*: it debits one account and credits another by the same positive amount. Direction is which account is debit vs credit, never a plus or minus sign. Assets and expenses grow on the debit side; liabilities, income, and equity grow on the credit side. (The skill ships the full debit/credit direction table, plus the compound `linked` form for splits like a payslip and the conversion-pair pattern for cross-currency rows.)

This is the loop the skill teaches an agent to run:

1. **Discover**: `plasalid ingest list --json` to find new/pending files.
2. **Prepare**: `plasalid ingest prepare <path>` registers the file and returns its readable `document` path, unlocking encrypted PDFs via `plasalid vault`.
3. **Read**: the agent reads the statement PDF directly (modern agent models read PDFs natively; Plasalid stays deterministic).
4. **Commit**: the agent pipes the transactions it extracted (one debit account, one credit account, one positive amount per row; splits go as a compound `linked` group), as NDJSON or a JSON array, into `plasalid ingest commit`. The harness posts them into the ledger and raises a question for anything it can't resolve confidently (unknown merchant, fuzzy account match, uncategorized fallback, cross-currency row).
5. **Resolve**: the agent (or you) works through `plasalid questions list` / `answer` / `defer` for whatever got raised, then closes the file out with `plasalid ingest done <id>`.

## Commands

Run `plasalid --help` (or `plasalid <noun> --help`) for the full flag reference. Grouped overview:

```
plasalid                # Harness status: config, database, ledger counts, net worth (default)
plasalid doctor         # Diagnose the harness environment
plasalid setup          # Install the skill for an agent CLI (--claude | --codex)
plasalid config         # Configure the harness (converge/init) and show configuration

plasalid ingest         # Ingest pipeline: list / prepare / commit / done / fail
plasalid files          # Browse ingested files (list / show / drop)
plasalid vault          # Manage file-password patterns for encrypted statements

plasalid transactions   # Transactions: list / show / add / update / delete / recategorize / dedupe
plasalid accounts       # Manage the chart of accounts
plasalid merchants      # Manage merchants and their default accounts
plasalid questions      # List, answer, and defer open questions

plasalid report         # Income / expenses / net over a date range (net worth: plasalid status)
plasalid notes          # Manage freeform notes
plasalid datasets       # Reference datasets: `plasalid datasets [name]` (institutions, defaults)

plasalid data           # Open the data folder in your OS file explorer (alias: open)
```

## Security & Privacy

- All financial data stays on your machine, encrypted with AES-256 (libsql); default `~/.plasalid/db.sqlite`.
- The config file (`~/.plasalid/config.json`) carries `0600` permissions; the only secret it holds is the database encryption key, and `config`/`status` only ever surface a fingerprint of it, never the plaintext.
- Encrypted-PDF passwords sit AES-GCM-encrypted in `db.sqlite` under a filename pattern; plaintext never touches disk.
- Read commands mask PII in free-text fields by default; `--no-redact` returns verbatim text.
- No telemetry, no analytics. Plasalid makes no network calls of its own.

## Configuration

Plasalid stores everything in `~/.plasalid/`:

```
~/.plasalid/
  config.json    # locale, currency, paths, encryption key fingerprint (0600 permissions)
  context.md     # persistent freeform context an agent can read (path shown as context_path in plasalid config show)
  db.sqlite      # encrypted SQLite database
  data/          # drop any PDFs here (subfolders allowed)
  cache/         # scratch space for rasterized/decrypted pages handed to an agent
```

### Environment variables

See `.env.example` for the current list:

```bash
# Relocates the entire ~/.plasalid directory, including config.json.
PLASALID_DIR=

# Passphrase used to encrypt the local SQLite database (AES-256).
# `plasalid config --generate-key` generates one if left blank.
PLASALID_DB_ENCRYPTION_KEY=

# Default: ~/.plasalid/db.sqlite
PLASALID_DB_PATH=

# Default: ~/.plasalid/data
PLASALID_DATA_DIR=

# Scratch space for decrypted/rasterized artifacts handed to external agent CLIs.
# Default: ~/.plasalid/cache
PLASALID_CACHE_DIR=
```

## Contributing

```bash
git clone https://github.com/phureewat29/plasalid
cd plasalid
npm install
npm run build
npm link # makes 'plasalid' available globally
```

`npm run integration` builds the CLI and runs a two-stage integration test against the built binary: a read-surface sweep (NDJSON validity, exit codes, zero ANSI) and a full write-path lifecycle in an isolated environment.

## License

Plasalid uses the [Apache License 2.0 with the Commons Clause](./LICENSE).

You're free to use, copy, modify, distribute, and fork it. The Commons Clause adds one restriction: **you may not Sell the Software**, meaning you may not provide a paid product or service whose value derives entirely or substantially from Plasalid's functionality (including paid hosting or support). For commercial-resale rights, contact the copyright holder to negotiate a separate license.
