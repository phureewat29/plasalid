# Corgi Agent

Corgi Agent is a personal-finance tracker agent: the `claude` CLI (Claude Code)
driving the plasalid harness end to end over a real, password-protected Thai
credit-card statement. Using nothing but the documented `plasalid` CLI surface,
the agent:

1. **Discover**s the statement dropped into the data directory
   (`plasalid ingest list` — it reports the file as encrypted, with a vault
   password available).
2. **Prepare**s it — the vault decrypts the PDF and returns a readable
   `document` path (`plasalid ingest prepare`).
3. **Read**s the statement PDF directly and extracts every transaction row,
   including refunds and the card-payment row (negative amounts become
   direction flips, never negative transfers).
4. **Commit**s the extracted rows into the ledger
   (`plasalid ingest commit` / `done`), with idempotent row ids so a re-run
   never double-posts.
5. **Report**s back — spending by category, refunds, top merchants — from
   `plasalid status`, `plasalid report`, and `plasalid ledger`.

The agent only has permission to run `plasalid` and read files
(`--allowedTools "Bash(plasalid:*),Read"`) — everything it does, it does
through the CLI's documented commands.

## Prerequisites

- Node.js >= 18
- The `claude` CLI installed and authenticated (e.g. `claude auth login`)

## Run it

```sh
./demo.sh
```

Two environment variables change the script's behavior:

- `SKIP_CLAUDE=1` — skip the live `claude -p` calls and only check the
  plumbing (build, statement placement, skill install, `ingest list` shows
  the encrypted file with a vault candidate). Useful when the `claude` CLI
  isn't installed/authenticated, or when iterating on the script itself.
- `KEEP_WORKSPACE=1` — don't delete the isolated workspace on exit; the
  script prints its path so you can poke around afterwards.

## What to expect

The script builds the project, places the statement, stores its password in
the vault, installs the plasalid skill so `claude` can discover it, then runs
two non-interactive `claude -p` prompts:

1. *"ingest my new statements, then summarize what you found — biggest
   spending categories, any refunds, and the card payment"*
2. *"how much did I spend in this billed period, and what were my top
   merchants?"*

Both answers are printed to the terminal, followed by a deterministic
assertion check (at least one file scanned, at least one transfer recorded)
and a final `PASS` or `FAIL` line.

## The statement

`card-statement-2026-05.pdf` is a real ttb credit-card statement published by
the project author as demo data. It ships **password-protected (AES-256)**;
the password is `corgimoho` and the demo stores it in plasalid's encrypted
vault, which is how the harness unlocks statements without ever prompting.

## Isolation

- **The run never touches your real `~/.plasalid`.** `demo.sh` builds an
  isolated workspace and redirects `HOME`, `PLASALID_DB_PATH`,
  `PLASALID_DATA_DIR`, and `PLASALID_CACHE_DIR` into it before doing anything
  else — your real `~/.plasalid` installation (if you have one) is never
  read or written.

## How it works (file map)

| File | Purpose |
| --- | --- |
| `card-statement-2026-05.pdf` | The password-protected card statement the agent ingests. |
| `demo.sh` | Builds the project, sets up an isolated workspace, places the statement, stores its password in the vault, installs the plasalid skill for Claude Code, runs the live `claude -p` demo (or the `SKIP_CLAUDE=1` plumbing check), and asserts the outcome. |
| `generate-statement.ts` | Builds a one-page card-statement PDF from constant data (optionally `--encrypt`ed) — used by `npm run integration` as its test fixture. |
| `README.md` | This file. |
