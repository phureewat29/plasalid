#!/usr/bin/env bash
#
# End-to-end demo: an external `claude` CLI agent drives the plasalid harness
# through discover -> prepare -> read pages -> commit -> report, using only
# the documented `plasalid` CLI surface (Bash(plasalid:*) is the only tool
# the agent is allowed to run).
#
# The whole run is isolated from any real ~/.plasalid installation: HOME,
# the sqlite db path, the data dir, and the cache dir are all redirected into
# a throwaway temp workspace (same isolation pattern as scripts/smoke.ts).
#
# Usage:
#   ./run-demo.sh                 # full demo (requires the `claude` CLI)
#   SKIP_CLAUDE=1 ./run-demo.sh   # plumbing-only check, no `claude` required
#   KEEP_DEMO_TMP=1 ./run-demo.sh # leave the temp workspace on disk afterwards
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)"

echo "==> Building plasalid ($REPO_ROOT)"
npm run build --prefix "$REPO_ROOT"

TMP="$(mktemp -d)"
echo "==> Temp workspace: $TMP"

cleanup() {
  local exit_code=$?
  if [ "${KEEP_DEMO_TMP:-0}" = "1" ]; then
    echo "==> KEEP_DEMO_TMP=1: leaving temp workspace at $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p "$TMP/home" "$TMP/data" "$TMP/cwd" "$TMP/bin" "$TMP/cache"

# --- bin shim: put a `plasalid` on PATH that runs this checkout's build ----
cat > "$TMP/bin/plasalid" <<EOF
#!/bin/sh
exec node "$REPO_ROOT/dist/cli/index.js" "\$@"
EOF
chmod +x "$TMP/bin/plasalid"
export PATH="$TMP/bin:$PATH"

# --- isolation env (mirrors scripts/smoke.ts's temp-env pattern) ----------
export HOME="$TMP/home"
export USERPROFILE="$TMP/home"
export PLASALID_DB_PATH="$TMP/db.sqlite"
export PLASALID_DATA_DIR="$TMP/data"
export PLASALID_CACHE_DIR="$TMP/cache"
export PLASALID_DB_ENCRYPTION_KEY=""
export NO_COLOR=1

# --- synthetic, fictional bank statement -----------------------------------
mkdir -p "$TMP/data/kasibank"
echo "==> Generating synthetic bank statement"
npx tsx "$SCRIPT_DIR/generate-statement.ts" "$TMP/data/kasibank/2026-06.pdf"

cd "$TMP/cwd"

echo "==> Installing plasalid skill for Claude Code"
plasalid agent-setup --dir "$TMP/cwd/.claude" --json

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

echo "==> claude agent: ingest my new statements, then summarize what you found"
ANSWER_1="$(claude -p "ingest my new statements, then summarize what you found" \
  --allowedTools "Bash(plasalid:*),Read")"
echo "----- claude answer (ingest + summarize) -----"
echo "$ANSWER_1"
echo "-----------------------------------------------"

echo "==> claude agent: what's my net worth and what did I spend money on this month?"
ANSWER_2="$(claude -p "what's my net worth and what did I spend money on this month?" \
  --allowedTools "Bash(plasalid:*),Read")"
echo "----- claude answer (net worth + spending) -----"
echo "$ANSWER_2"
echo "-------------------------------------------------"

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

echo "PASS: files.scanned >= 1 and counts.transfers > 0"
