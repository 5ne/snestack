#!/usr/bin/env bash
# Nightly financial analysis: data-dump -> run-skill (both skills, every ticker)
# -> distill-signals -> notify. This is the automated version of
# prompts/daily-analysis.md, using `distill-signals` in place of a human/Claude-Code
# session doing step 3 by hand. Every command here is a plain deterministic CLI
# call (each with its own single Claude API call where noted) — no agentic
# tool-use loop, so no elevated/unattended permissions are needed to run this
# unattended from cron.
set -euo pipefail

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NODE_DIR"

if [ ! -f dist/cli.js ]; then
  echo "dist/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi

BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
RUN_DIR="$BRAIN_ROOT/financial/signals/$(date +%Y-%m-%d)"
mkdir -p "$RUN_DIR"

echo "Run directory: $RUN_DIR"

# Step 1: refresh quote/RSI/MA + fundamentals for every position/watchlist ticker.
node dist/cli.js data-dump > "$RUN_DIR/data-dump.json"

TICKERS="$(node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const lines = raw.split("\n");
  const start = lines.findIndex(l => l === "[");
  const arr = JSON.parse(lines.slice(start).join("\n"));
  arr.forEach(d => console.log(d.ticker));
' "$RUN_DIR/data-dump.json")"

if [ -z "$TICKERS" ]; then
  echo "No positions/watchlist tickers found — nothing to analyze." >&2
  exit 0
fi

# Step 2: run both skills for every ticker. Each call is its own Claude judgment.
while IFS= read -r TICKER; do
  echo "Analyzing $TICKER..."
  node dist/cli.js run-skill financial long-term-quality "$TICKER" \
    > "$RUN_DIR/$TICKER-long-term-quality.md" 2>&1 || true
  node dist/cli.js run-skill financial swing-trading-large-cap "$TICKER" \
    > "$RUN_DIR/$TICKER-swing-trading-large-cap.md" 2>&1 || true
done <<< "$TICKERS"

# Step 3: distill all of today's skill output into one signals array.
node dist/cli.js distill-signals --dir "$RUN_DIR" > "$RUN_DIR/signals.json"

# Step 4: send the batch email and record signals in snestack.db.
node dist/cli.js notify --file "$RUN_DIR/signals.json"

echo "Done. Full run saved under: $RUN_DIR"
