# Corgi Agent

Corgi Agent is a standalone ink TUI demo: the `claude` CLI (Claude Code)
driving the plasalid harness end to end over a real, password-protected Thai
credit-card statement. Using nothing but the documented `plasalid` CLI
surface, the agent:

1. **Discover**s the statement dropped into the data directory
   (`plasalid ingest list` -- it reports the file as encrypted, with a vault
   password available).
2. **Prepare**s it -- the vault decrypts the PDF and returns a readable
   `document` path (`plasalid ingest prepare`).
3. **Read**s the statement PDF directly and extracts every transaction row,
   including refunds and the card-payment row (negative amounts become
   direction flips, never negative transactions).
4. **Commit**s the extracted rows into the ledger
   (`plasalid ingest commit` / `done`), with idempotent row ids so a re-run
   never double-posts.
5. **Report**s back -- spending by category, refunds, top merchants -- from
   `plasalid status`, `plasalid report`, and `plasalid ledger`.

The agent only has permission to run `plasalid` and read/write files
(`--allowedTools "Bash(plasalid:*),Read,Write"`) -- everything it does, it
does through the CLI's documented commands.

This is its own small project: it has its own `package.json` and
dependencies (ink + React) and imports nothing from the root plasalid
package's source.

## Prerequisites

- Node.js >= 18
- The `claude` CLI installed and authenticated (e.g. `claude auth login`),
  unless you only want the `--skip-claude` plumbing check

## Run it

```sh
cd examples/corgi-agent
npm install
npm start
```

Two flags change the run's behavior (pass them after `--` so npm forwards
them to the demo):

- `npm start -- --skip-claude` -- skip the live `claude -p` turns and only
  check the plumbing (build, statement placement, skill install, vault
  unlock, and that `plasalid ingest list` discovers the statement). Useful
  when the `claude` CLI isn't installed/authenticated, or when iterating on
  the demo itself. Prints `PASS`/`FAIL` and exits 0/1.
- `npm start -- --keep-workspace` -- don't delete the isolated workspace on
  exit; the run prints its path so you can poke around afterwards.

Both flags can be combined: `npm start -- --skip-claude --keep-workspace`.

## What each step shows

Whether stdout is a terminal or piped, the same information is reported --
a live ink dashboard on a TTY, and flat sequential lines when piped (e.g.
`npm start -- --skip-claude | cat`). Steps render as `[....]` while running,
`[ ok ]` once they pass, and `[fail]` if they don't:

1. **build plasalid** -- `npm run build` at the repo root.
2. **create workspace** -- a fresh, throwaway temp directory for this run.
3. **write bin shim** -- a `plasalid` shim script pointing at the freshly
   built `dist/cli/index.js`.
4. **export isolation env** -- `PATH` (so the shim resolves), `HOME` /
   `USERPROFILE`, and the `PLASALID_*` variables described below.
5. **place statement** -- copies `card-statement-2026-05.pdf` into the
   workspace's data directory.
6. **install skill** -- installs the plasalid skill pack so `claude` can
   discover the harness.
7. **vault add password** -- stores the statement's password in the
   encrypted vault (piped over stdin, never as a command-line argument).
8. **status check** -- confirms the harness is reachable before handing off
   to `claude`.

With `--skip-claude`, a final **ingest list plumbing check** step runs
`plasalid ingest list --json` and asserts at least one newly-discovered file
is awaiting ingest, then the run prints `PASS`/`FAIL` and exits.

Otherwise, the demo runs a three-turn conversation in ONE continued `claude`
session (`claude -p`, then `claude -p --continue` twice -- the agent keeps
its context across turns, exactly like day-to-day usage). Each turn gets its
own panel showing the tool calls the agent makes (`> plasalid ...`,
`> Read <path>`, `> Write <path>`) followed by its final answer:

1. *"ingest my new statements, then give me a quick summary of what you
   found"*
2. *"resolve any open questions using your own judgment, and capture the
   card's statement metadata (masked number, points, due day) onto the
   account"*
3. *"how much did I spend this billed period, what were my top merchants,
   and what should I watch next month?"*

After the three turns, a **final assertions** step re-checks
`plasalid status --json` (at least one file scanned, at least one transaction
recorded), reports the number of open questions left (informational -- the
agent may defer some), and the run prints a final `PASS`/`FAIL` line.

## The statement

`card-statement-2026-05.pdf` is a real ttb credit-card statement published by
the project author as demo data. It ships **password-protected (AES-256)**;
the password is `corgimoho` and the demo stores it in plasalid's encrypted
vault, which is how the harness unlocks statements without ever prompting.

## Isolation

- **The run never touches your real `~/.plasalid`.** Every run builds a
  fresh, isolated workspace and redirects `HOME`/`USERPROFILE`,
  `PLASALID_DB_PATH`, `PLASALID_DATA_DIR`, and `PLASALID_CACHE_DIR` into it
  before doing anything else -- your real `~/.plasalid` installation (if you
  have one) is never read or written. The workspace is deleted on exit
  (including on Ctrl-C) unless you pass `--keep-workspace`.

## How it works (file map)

| File | Purpose |
| --- | --- |
| `card-statement-2026-05.pdf` | The password-protected card statement the agent ingests. |
| `package.json` | This sub-project's own manifest (ink + React dependencies, `npm start`). |
| `tsconfig.json` | This sub-project's own TypeScript config. |
| `src/demo.tsx` | Entry point: CLI args, TTY detection, the demo's step/turn orchestration, and both renderers (ink for a TTY, plain text when piped). |
| `src/workspace.ts` | Workspace setup/teardown, the isolation env, and the `plasalid` runner (including the `plasalid setup` skill install). |
| `src/claude-stream.ts` | Spawns `claude -p ... --output-format stream-json` and turns its NDJSON event stream into activity lines and a final answer. |
| `README.md` | This file. |
