#!/usr/bin/env bash
#
# End-to-end demo: an external `claude` CLI agent drives the plasalid harness
# through discover -> prepare -> read pages -> commit -> report, using only
# the documented `plasalid` CLI surface (Bash(plasalid:*) is the only tool
# the agent is allowed to run).
#
# The whole run is isolated from any real ~/.plasalid installation: HOME,
# the sqlite db path, the data dir, and the cache dir are all redirected into
# an isolated workspace (same isolation pattern as scripts/integration.ts).
#
# Usage:
#   ./demo.sh                  # full demo (requires the `claude` CLI)
#   SKIP_CLAUDE=1 ./demo.sh    # plumbing-only check, no `claude` required
#   KEEP_WORKSPACE=1 ./demo.sh # leave the workspace on disk afterwards
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)"

echo "==> Building plasalid ($REPO_ROOT)"
npm run build --prefix "$REPO_ROOT"

WORKSPACE="$(mktemp -d)"
echo "==> Workspace: $WORKSPACE"

cleanup() {
  local exit_code=$?
  if [ "${KEEP_WORKSPACE:-0}" = "1" ]; then
    echo "==> KEEP_WORKSPACE=1: leaving workspace at $WORKSPACE"
  else
    rm -rf "$WORKSPACE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p "$WORKSPACE/home" "$WORKSPACE/data" "$WORKSPACE/cwd" "$WORKSPACE/bin" "$WORKSPACE/cache"

# --- bin shim: put a `plasalid` on PATH that runs this checkout's build ----
cat > "$WORKSPACE/bin/plasalid" <<EOF
#!/bin/sh
exec node "$REPO_ROOT/dist/cli/index.js" "\$@"
EOF
chmod +x "$WORKSPACE/bin/plasalid"
export PATH="$WORKSPACE/bin:$PATH"

# --- isolation env (mirrors scripts/integration.ts's isolated-env pattern) --
export HOME="$WORKSPACE/home"
export USERPROFILE="$WORKSPACE/home"
export PLASALID_DB_PATH="$WORKSPACE/db.sqlite"
export PLASALID_DATA_DIR="$WORKSPACE/data"
export PLASALID_CACHE_DIR="$WORKSPACE/cache"
export PLASALID_DB_ENCRYPTION_KEY=""
export NO_COLOR=0

# --- card statement (ships already password-protected; the vault decrypts) ---
STATEMENT_PASSWORD="corgimoho"
mkdir -p "$WORKSPACE/data/ttb"
echo "==> Placing the password-protected card statement"
cp "$SCRIPT_DIR/card-statement-2026-05.pdf" "$WORKSPACE/data/ttb/card-statement-2026-05.pdf"

cd "$WORKSPACE/cwd"

echo "==> Installing plasalid skill for Claude Code"
plasalid agent-setup --dir "$WORKSPACE/cwd/.claude" --json

echo "==> Storing the statement password in the vault"
printf '%s' "$STATEMENT_PASSWORD" | plasalid vault add '^card-statement' --password-stdin --json

echo "==> Status before ingest"
plasalid status --json

if [ "${SKIP_CLAUDE:-0}" = "1" ]; then
  echo "==> SKIP_CLAUDE=1: skipping live claude -p steps, checking plumbing only"
  PENDING_JSON="$(plasalid ingest list --json)"
  echo "$PENDING_JSON"

  # A freshly-discovered file that has never been through `ingest prepare`
  # reports status "new" (see IngestStatus in src/scanner/ingest.ts) — it only
  # becomes "pending" once a scanned_files row exists for it. Since this
  # branch only runs `ingest list` (no prepare/commit), the summary's `new`
  # count is what proves discovery worked; `total` is the belt-and-suspenders
  # check that at least one file was found at all.
  PENDING_RESULT="$(node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const summary = lines.map((l) => JSON.parse(l)).find((o) => o.type === "summary");
    if (!summary) {
      console.log("FAIL no summary line in ingest list --json output");
    } else if (summary.new >= 1 && summary.total >= 1) {
      console.log("OK");
    } else {
      console.log(`FAIL expected new >= 1 and total >= 1, got new=${summary.new} total=${summary.total}`);
    }
  ' <<<"$PENDING_JSON")"

  if [ "$PENDING_RESULT" != "OK" ]; then
    echo "FAIL: $PENDING_RESULT" >&2
    exit 1
  fi
  echo "PASS: plumbing check ok (at least 1 newly-discovered file awaiting ingest)"
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "FAIL: the 'claude' CLI is not installed or not on PATH." >&2
  echo "      Install Claude Code and authenticate (e.g. 'claude auth login'), then re-run." >&2
  exit 1
fi

# Three turns, ONE continued session — the agent keeps its context across
# turns exactly like day-to-day usage. HOME points into the workspace, so
# --continue deterministically resumes this demo's own session.
DEMO_TOOLS="Bash(plasalid:*),Read,Write"

TURN_1="ingest my new statements, then give me a quick summary of what you found"
echo "==> turn 1: $TURN_1"
ANSWER_1="$(claude -p "$TURN_1" --allowedTools "$DEMO_TOOLS")"
echo "----- turn 1 answer (ingest + summary) -----"
echo "$ANSWER_1"
echo "--------------------------------------------"

TURN_2="resolve any open questions using your own judgment, and capture the card's statement metadata (masked number, points, due day) onto the account"
echo "==> turn 2 (continued session): $TURN_2"
ANSWER_2="$(claude -p --continue "$TURN_2" --allowedTools "$DEMO_TOOLS")"
echo "----- turn 2 answer (clarify + metadata) -----"
echo "$ANSWER_2"
echo "----------------------------------------------"

TURN_3="how much did I spend this billed period, what were my top merchants, and what should I watch next month?"
echo "==> turn 3 (continued session): $TURN_3"
ANSWER_3="$(claude -p --continue "$TURN_3" --allowedTools "$DEMO_TOOLS")"
echo "----- turn 3 answer (report + advice) -----"
echo "$ANSWER_3"
echo "-------------------------------------------"

echo "==> Deterministic assertions"
STATUS_JSON="$(plasalid status --json)"
echo "$STATUS_JSON"

ASSERT_RESULT="$(node -e '
  const data = require("fs").readFileSync(0, "utf8").trim();
  const status = JSON.parse(data.split("\n")[0]);
  const scanned = status.files ? status.files.scanned : 0;
  const transfers = status.counts ? status.counts.transfers : 0;
  if (scanned >= 1 && transfers > 0) {
    console.log("OK");
  } else {
    console.log(`FAIL scanned=${scanned} transfers=${transfers}`);
  }
' <<<"$STATUS_JSON")"

if [ "$ASSERT_RESULT" != "OK" ]; then
  echo "FAIL: $ASSERT_RESULT" >&2
  exit 1
fi

echo "==> Ledger (for flavor)"
plasalid ledger --json | head -5 || true

echo "==> Open questions after the clarify turn (informational — the agent may defer some)"
plasalid questions list --json || true

echo "PASS: files.scanned >= 1 and counts.transfers > 0"
