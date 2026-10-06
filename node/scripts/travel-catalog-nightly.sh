#!/usr/bin/env bash
# Nightly travel catalog refresh: re-runs `travel catalog` for a year so
# newly booked/taken trips get picked up incrementally. Deterministic wiring
# only — fetches Gmail + Timeline context and makes one Claude call per
# run; the judgment it encodes lives in
# domains/travel/skills/catalog-trip-year.md, not here. See that skill file
# for why this writes to a .nightly-draft/ staging directory instead of the
# year's canonical files, and node/README.md for the one-time `travel auth`
# setup this depends on.
#
# Usage: travel-catalog-nightly.sh [year]   (defaults to the current year)
set -euo pipefail

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NODE_DIR"

if [ ! -f dist/cli.js ]; then
  echo "dist/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi

YEAR="${1:-$(date +%Y)}"

echo "Cataloging travel for $YEAR..."
node dist/cli.js travel catalog "$YEAR"
echo "Done."
