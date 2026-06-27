# Claude agent demo

This demo shows an external agent — the `claude` CLI (Claude Code) — driving
the plasalid harness end to end, using nothing but the documented `plasalid`
CLI surface:

1. **Discover** a new bank statement dropped into the data directory
   (`plasalid ingest list`).
2. **Prepare** it — decrypt/rasterize pages for review
   (`plasalid ingest prepare`).
3. **Read** the rendered pages and extract the transactions.
4. **Commit** the extracted rows into the ledger
   (`plasalid ingest commit` / `done`).
5. **Report** back — net worth and spending, from `plasalid status` and
   `plasalid ledger`.

The agent only has permission to run `plasalid` itself
(`--allowedTools "Bash(plasalid:*)"`) — everything it does, it does through
the CLI's documented commands.

## Prerequisites

- Node.js >= 18
- The `claude` CLI installed and authenticated (e.g. `claude auth login`)

## Run it

```sh
./run-demo.sh
```

## What to expect

The script builds the project, generates a synthetic bank statement, installs
the plasalid skill so `claude` can discover it, then runs two non-interactive
`claude -p` prompts:

1. *"ingest my new statements, then summarize what you found"*
2. *"what's my net worth and what did I spend money on this month?"*

Both answers are printed to the terminal, followed by a deterministic
assertion check (at least one file scanned, at least one transfer recorded)
and a final `PASS` or `FAIL` line.

Two environment variables change the script's behavior:

- `SKIP_CLAUDE=1` — skip the live `claude -p` calls and only check the
  plumbing (build, statement generation, skill install, `ingest list` shows
  the pending file). Useful when the `claude` CLI isn't installed/authenticated,
  or when iterating on the script itself.
- `KEEP_DEMO_TMP=1` — don't delete the temporary workspace on exit; the
  script prints its path so you can poke around afterwards.

## Everything here is fake and isolated

- **KASI BANK is not a real bank.** The statement PDF
  (`generate-statement.ts`) hand-assembles a one-page PDF with a synthetic
  account number, a fictional bank name, and constant, made-up transactions.
- **The run never touches your real plasalid data.** `run-demo.sh` builds a
  throwaway temp workspace and redirects `HOME`, `PLASALID_DB_PATH`,
  `PLASALID_DATA_DIR`, and `PLASALID_CACHE_DIR` into it before doing anything
  else — your real `~/.plasalid` installation (if you have one) is never
  read or written.

## How it works (file map)

| File | Purpose |
| --- | --- |
| `generate-statement.ts` | Hand-assembles the synthetic one-page bank-statement PDF (no PDF-writing dependency) and self-checks the result by opening it with `mupdf`. |
| `run-demo.sh` | Builds the project, sets up an isolated temp environment, generates the statement, installs the plasalid skill for Claude Code, runs the live `claude -p` demo (or the `SKIP_CLAUDE=1` plumbing check), and asserts the outcome. |
| `README.md` | This file. |
