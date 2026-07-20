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

In the US and Europe, most financial apps are powered by aggregators like Plaid. You can link your bank accounts once and see your entire financial life in one place. But for most of the world, Thailand included, that infrastructure simply does not exist.

Your data is locked in bank silos. Tracking your net worth means logging into half a dozen apps and crunching the numbers manually. This fragmentation creates massive blind spots. Subscriptions are forgotten, strange charges go unnoticed, and planning for big financial goals becomes a guessing game.

**Plasalid is built to fix this — as a harness for agents, not another app.**

You drop your raw financial documents (bank statements, credit card bills, payslips) into a folder on your machine. Any agent you already use — a coding agent in your terminal, or an assistant in a chat app that accepts skills — picks up one skill file and takes it from there, keeping your books on a deterministic, auditable, double-entry ledger that lives encrypted on your machine.

Plasalid itself has no built-in AI model, no API key to configure, no chat window. It is the harness underneath: stable commands, strict JSON, exit codes an agent can branch on. Setting an agent up is one step — see [Give it to your agent](#give-it-to-your-agent).

## Features

### Unified ledger from any financial document

* **Drop PDFs, get a pipeline.** `plasalid ingest list` discovers new statements, `plasalid ingest prepare` hands back a readable statement document (unlocking encrypted PDFs via a stored password vault), and `plasalid ingest commit` posts the transactions an agent extracted straight into a double-entry ledger.
* **No aggregators or per-bank logins.** The big picture builds itself from the documents you already get every month. Zero manual data entry and no fragile bank connectors to maintain.

### A harness, not a black box

* **Every command speaks JSON.** `--json` turns any command into NDJSON — one object per line, a `summary` line to close out a batch, and a single JSON object on stderr on failure. Exit codes are stable and specific (see below), so an agent (or a shell script) can branch on outcome without scraping text.
* **Open questions instead of silent guesses.** When the pipeline can't confidently resolve an account or a merchant, it raises a question (`plasalid questions list`) instead of guessing. You or your agent resolve it once with `plasalid questions answer`, and that resolution is remembered.
* **Full manual control when you want it.** Every step of the pipeline — accounts, transactions, merchants — is also a plain CLI command. Drive it by hand, script it, or hand the whole thing to an agent.

### Local-first, encrypted, and inspectable

* **Everything runs on your machine.** Your ledger is stored in an AES-256 encrypted SQLite database (via libsql). There are no cloud aggregators or upstream accounts. Nothing leaves your machine unless you pipe it somewhere yourself.
* **Redaction on tap.** Read commands that touch free text (`status`, `accounts list`, `transactions list`, `transactions show`, `questions list`) take a `--redact` flag to mask PII before you pass output to an external agent or paste it anywhere.
* **No telemetry, no analytics.** The only thing Plasalid writes to disk is your own data, under `~/.plasalid/`.

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
plasalid data          # opens ~/.plasalid/data in Finder/Explorer — drag PDFs in
```

## Give it to your agent

The entire skill is one markdown file checked into this repo: [`skills/SKILL.md`](./skills/SKILL.md). There is no build step — what you see at that link is exactly what every agent gets (`plasalid setup --print` prints the same bytes).

**Chat apps with a skill UI** (Claude Desktop, Kimi, and the like): add the skill by URL or file upload:

```
https://raw.githubusercontent.com/phureewat29/plasalid/main/skills/SKILL.md
```

That link always tracks the latest skill; to pin a release, use a tag URL such as `.../v0.10.2/skills/SKILL.md`. The skill teaches the agent to install the CLI from npm and run first-time setup itself — so end users just ask: *"set up plasalid and ingest my statements."*

**Terminal agent CLIs** (Claude Code, Codex, and the like): install the same file locally:

```bash
plasalid setup            # writes ./.claude/skills/plasalid (--global for your home dir)
plasalid setup --codex    # maintains a plasalid block in AGENTS.md instead
```

Then ask your agent: *"ingest my new statements."* It will discover, prepare, and read each file, commit the transactions it finds, and walk you through any open questions.

## Example Agent with Plasalid

**Corgi Agent** — a demo personal-finance tracker agent for daily life using Plasalid as harness. The example ships a real, password-protected credit-card statement; the agent unlocks it through the vault, reads it, posts every transaction into the ledger, and answers spending questions - a three-turn continued `claude -p` session rendered in a live terminal UI, all in an isolated workspace.

```bash
cd examples/corgi-agent
npm install
npm start
```

Requires the `claude` CLI (or run `npm start -- --skip-claude` for a plumbing-only check without it); nothing touches your real data.

## The Agent Workflow

Every row becomes a *transaction*: it debits one account and credits another by the same positive amount — direction is which account is debit vs credit, never a plus/minus sign. Assets and expenses grow on the debit side; liabilities, income, and equity grow on the credit side. (The skill ships the full debit/credit direction table, plus the compound `linked` form for splits like a payslip and the conversion-pair pattern for cross-currency rows.)

This is the loop the skill teaches an agent to run:

1. **Discover** — `plasalid ingest list --json` to find new/pending files.
2. **Prepare** — `plasalid ingest prepare <path>` registers the file and returns its readable `document` path, unlocking encrypted PDFs via `plasalid vault`.
3. **Read** — the agent reads the statement PDF directly (modern agent models read PDFs natively; Plasalid stays deterministic).
4. **Commit** — the agent pipes the transactions it extracted (one debit account, one credit account, one positive amount per row; splits go as a compound `linked` group), as NDJSON or a JSON array, into `plasalid ingest commit`. The harness posts them into the ledger and raises a question for anything it can't resolve confidently (unknown merchant, fuzzy account match, uncategorized fallback, cross-currency row).
5. **Resolve** — the agent (or you) works through `plasalid questions list` / `answer` / `defer` for whatever got raised, then closes the file out with `plasalid ingest done <id>`.

## Commands

Run `plasalid --help` (or `plasalid <noun> --help`) for the full flag reference. Grouped overview:

```
plasalid                # Harness status: config, database, ledger counts, net worth (default)
plasalid doctor         # Diagnose the harness environment
plasalid setup          # Install the skill for an agent CLI (--claude | --codex)
plasalid config         # Configure the harness (converge/init) and show configuration

plasalid ingest         # Ingest pipeline: list / prepare / commit / done / fail
plasalid files          # Browse scanned files (list / show / drop)
plasalid vault          # Manage file-password patterns for encrypted statements

plasalid transactions   # Transactions: list / show / add / update / delete / recategorize / dedupe
plasalid accounts       # Manage the chart of accounts
plasalid merchants      # Manage merchants and their default accounts
plasalid questions      # List, answer, and defer open questions

plasalid report         # Income / expenses / net over a date range (net worth: plasalid status)
plasalid notes          # Manage freeform notes

plasalid data           # Open the data folder in your OS file explorer (alias: open)
```

## The `--json` contract

Every command supports three output modes, resolved once per run:

| Mode | Trigger | Shape |
|---|---|---|
| NDJSON | `--json` | One JSON object per record on stdout; a `{"type":"summary",...}` line closes out streaming commands; on failure, one JSON object on stderr. Never colored. |
| Human table | TTY, no `--json` | Aligned, colored (chalk) tables. |
| Plain | piped, no `--json` | Tab-separated rows, zero ANSI, stable for scripts that don't want JSON. |

Global flags on every command: `--json`, `--no-color`.

Exit codes are stable across the whole CLI:

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | success |
| 1 | GENERIC | unexpected error |
| 2 | USAGE | bad flags/arguments |
| 3 | NOT_READY | harness not configured / database not reachable |
| 4 | INPUT_REQUIRED | needs a password, confirmation, or other input |
| 5 | NOT_FOUND | referenced id/pattern doesn't exist |
| 6 | INVALID | input failed validation |
| 7 | PARTIAL | a batch operation partially succeeded (see `ingest commit`) |

## Security & Privacy

- All financial data stored locally, encrypted with AES-256 (libsql), default `~/.plasalid/db.sqlite`.
- Config file (`~/.plasalid/config.json`) written with `0600` permissions; the only secret it holds is the database encryption key, and `config`/`status` only ever surface a fingerprint of it, never the plaintext.
- Encrypted-PDF passwords are stored AES-GCM-encrypted in `db.sqlite` under a filename pattern; never written to disk in plaintext.
- `--redact` masks PII in free-text fields on read commands before you pipe output anywhere.
- No telemetry, no analytics, no network calls made by Plasalid itself.

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

See `.env.example` for the full, current list. As of this release:

```bash
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

Plasalid is released under the [Apache License 2.0 with the Commons Clause](./LICENSE).

You're free to use, copy, modify, distribute, and fork it. The Commons Clause adds one restriction: **you may not Sell the Software** — that is, you may not provide a paid product or service whose value derives entirely or substantially from Plasalid's functionality (including paid hosting or support). For commercial-resale rights, contact the copyright holder to negotiate a separate license.
