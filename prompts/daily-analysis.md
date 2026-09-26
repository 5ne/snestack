You are running the snestack financial domain's nightly analysis. Follow these steps exactly, in order. Do not deviate, do not run any command not listed below, and do not touch git, edit files, or do anything destructive.

Working directory: `/Users/carpool/Documents/Claude/Projects/fstack/node`. All commands below need `NODE_OPTIONS=--experimental-sqlite` set.

Before starting, compute today's run directory and create it:
```
RUN_DIR=~/Documents/personal-brain/financial/signals/$(date +%Y-%m-%d)
mkdir -p "$RUN_DIR"
```
Every step below writes its output into `$RUN_DIR` as it happens, so progress can be checked mid-run by just looking at that directory — no need to watch this session's live output.

## Step 1 — Refresh data

Run, saving a copy of the output:
```
NODE_OPTIONS=--experimental-sqlite node dist/cli.js data-dump | tee "$RUN_DIR/data-dump.json"
```

This fetches fresh quotes/RSI/MA (Finnhub) and fundamentals (Morningstar) for every position and watchlist ticker, and — as a side effect — writes the fresh quote/RSI/MA data into `snestack.db` (which lives in the shared Google Drive folder at `~/Documents/personal-brain/financial/`). This step alone is what "updates the financial records in Google Drive" — nothing further is needed for that part.

The output is a JSON array, also now saved at `$RUN_DIR/data-dump.json`. For each entry, note: `ticker`, `isPosition`, `isWatchlist`.

## Step 2 — Run both skills for every ticker

For **every ticker** in the data-dump output, run both of these (substituting the actual ticker), writing each result to its own file as it completes:

```
NODE_OPTIONS=--experimental-sqlite node dist/cli.js run-skill financial long-term-quality <TICKER> | tee "$RUN_DIR/<TICKER>-long-term-quality.md"
NODE_OPTIONS=--experimental-sqlite node dist/cli.js run-skill financial swing-trading-large-cap <TICKER> | tee "$RUN_DIR/<TICKER>-swing-trading-large-cap.md"
```

Each call is its own real judgment call — read the full reasoning output. The swing-trading skill will say plainly if a ticker isn't eligible (large-cap/profitable filter) — that's expected, not an error; the file still gets written, just don't include an entry for it in step 3. Because each file appears the moment that ticker's judgment finishes, checking `ls "$RUN_DIR"` at any point during the run shows exactly how far it's gotten.

## Step 3 — Distill into a signals array

For each skill result that produced an actual recommendation (skip ineligible swing-trading results), extract:
- `ticker`
- `recommendation`: BUY, SELL, or HOLD (map the skill's own vocabulary — e.g. "BUY-more"/"TRIM" — onto these three)
- `confidence`: your best-effort 0.0–1.0 read of how strongly the reasoning supports the call
- `reasoning`: 1–2 sentences summarizing the actual reasoning, prefixed with `[Long-term]` or `[Swing]` so it's clear which skill produced it
- `fromWatchlist`: true if `isWatchlist` was true for that ticker in step 1's output, else false

A ticker can appear twice (once per skill) — that's fine, they're two independent judgments.

## Step 4 — Send it

First save the assembled array so it's on disk before sending:
```
cat > "$RUN_DIR/signals.json" <<'EOF'
[ ...the JSON array from step 3... ]
EOF
```

Then send it:
```
NODE_OPTIONS=--experimental-sqlite node dist/cli.js notify --file "$RUN_DIR/signals.json"
```

This sends the batch email and records each signal in `snestack.db`.

## Step 5 — Report back

Print a short summary: how many tickers were analyzed, how many BUY/SELL/HOLD signals were produced, whether `notify` reported success, and the `$RUN_DIR` path where everything from this run was saved.
