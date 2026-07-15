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

The agent only has permission to run `plasalid`, read/write files, and use
Claude Code Skills (`--allowedTools "Bash(plasalid:*),Read,Write,Skill"`) --
everything it does, it does through the CLI's documented commands.

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

Three flags change the run's behavior (pass them after `--` so npm forwards
them to the demo):

- `npm start -- --skip-claude` -- skip the live `claude -p` turns and only
  check the plumbing (build, statement placement, skill install, vault
  unlock, and that `plasalid ingest list` discovers the statement). Useful
  when the `claude` CLI isn't installed/authenticated, or when iterating on
  the demo itself. Prints `PASS`/`FAIL` and exits 0/1.
- `npm start -- --keep-workspace` -- don't delete the isolated workspace on
  exit; the run prints its path so you can poke around afterwards.
- `npm start -- --turn-timeout <seconds>` -- kill a `claude -p` turn
  (SIGTERM, then SIGKILL 5s later if it's still alive) if it runs longer
  than this. Defaults to 600s (10 minutes).

Flags can be combined: `npm start -- --skip-claude --keep-workspace`.

For development, `npm run verify` runs a fast offline check that the ink render
clock coalesces a burst of streaming deltas into TICK-cadence updates (no
per-delta re-renders); it needs neither `claude` nor the plasalid build.

## What to expect

Whether stdout is a terminal or piped, the same information is reported --
a live ink dashboard on a TTY, and flat sequential lines when piped (e.g.
`npm start -- --skip-claude | cat`). Both renderers drive the identical
underlying orchestration; only the presentation differs:

- **TTY (ink) mode** -- a live dashboard with tasteful emoji and color
  accents: a spinner (braille cycle, via `ink-spinner`) plus an `elapsed Ns`
  counter next to whatever's currently running, `✅`/`❌` once a step or turn
  finishes, and each turn's answer streams in live (dim/italic) as the agent
  generates it, before being replaced by the authoritative final answer.
  Finished turns are pinned to scrollback (via ink's `<Static>`) so the
  live-updating parts of the screen never repaint history.
- **Piped/plain mode** -- pure ASCII, one line at a time, no emoji, no
  spinner, no live-streaming text. Steps render as `[....]` while running,
  `[ ok ]` once they pass, and `[fail]` if they don't. While a turn is
  running with no other output, a `... thinking (Ns)` heartbeat line prints
  at most every 15s so a long silent stretch doesn't look hung.

Steps, in order:

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

Otherwise, a **check claude CLI** preflight step runs `claude --version`
first, so a missing/broken `claude` install fails immediately with a
friendly message instead of a raw `ENOENT` once the first turn tries to
spawn it.

The demo then runs a three-turn conversation in ONE continued `claude`
session (`claude -p`, then `claude -p --continue` twice -- the agent keeps
its context across turns, exactly like day-to-day usage). Each turn gets its
own panel showing the tool calls the agent makes (`> plasalid ...`,
`> Read <path>`, `> Write <path>`, `> Skill`) followed by its final answer:

1. *"ingest my new statements, then give me a quick summary of what you
   found"*
2. *"resolve any open questions using your own judgment, and capture the
   card's statement metadata (masked number, points, due day) onto the
   account"*
3. *"how much did I spend this billed period, what were my top merchants,
   and what should I watch next month?"*

After each turn, the run reports (informational, not an assertion) whether
the agent loaded the plasalid skill (turn 1 only) and how many `plasalid`
commands it ran that turn, plus a done/failed summary line with duration
when the `claude` CLI reports it, e.g.
`✅ turn 1 done in 84s · 12 plasalid calls` in ink mode, or
`turn 1 done in 84s (12 plasalid calls)` when piped. If a turn otherwise
succeeds but still wrote to stderr, the last few lines are shown (dimmed in
ink mode, prefixed `stderr:` when piped) rather than silently discarded.

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
- **Linux auth note**: because the isolation env redirects `HOME` into the
  throwaway workspace, `claude` can't see `$HOME/.claude` in that workspace
  -- on Linux, that's where `claude auth login` credentials normally live, so
  a Linux run of the full demo (not `--skip-claude`) needs `ANTHROPIC_API_KEY`
  set in the environment instead. macOS is unaffected by this specific issue,
  since `claude` there reads credentials from the system Keychain rather than
  a `$HOME`-relative file (an `ANTHROPIC_API_KEY` also works there).

## How it works (file map)

| File | Purpose |
| --- | --- |
| `card-statement-2026-05.pdf` | The password-protected card statement the agent ingests. |
| `package.json` | This sub-project's own manifest (ink + ink-spinner + React dependencies, `npm start`, `npm run verify`). |
| `tsconfig.json` | This sub-project's own TypeScript config. |
| `src/demo.tsx` | Thin entry point: CLI arg handling, TTY detection, picking the renderer, and process-level workspace cleanup. |
| `src/args.ts` | CLI argument parsing (`--skip-claude`, `--keep-workspace`, `--turn-timeout`) and the usage text. |
| `src/orchestrate.ts` | The demo's step/turn orchestration (`runDemo`), reported through the `Reporter` contract with no UI knowledge. |
| `src/reporters.ts` | The `Reporter` contract, the plain (piped) and ink reporters, and the formatting helpers both share. |
| `src/ui-state.ts` | The ink UI's types, render-clock constants, and the single pure reducer. |
| `src/ui.tsx` | The ink (TTY) renderer: dashboard components and the App that drives the render clock. |
| `src/workspace.ts` | Workspace setup/teardown, the isolation env, the `plasalid` runner (including the `plasalid setup` skill install), and the `claude` CLI preflight check. |
| `src/claude-stream.ts` | Spawns `claude -p ... --output-format stream-json` (with a per-turn timeout) and turns its NDJSON event stream into activity/skill/plasalid-call events, coalesced live-streaming answer text, and the turn's final answer/duration. |
| `src/verify-render-clock.ts` | Dev check (`npm run verify`) that the render clock bounds visible updates to the TICK cadence. |
| `README.md` | This file. |
