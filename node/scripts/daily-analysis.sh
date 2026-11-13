#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")/.." && pwd)/src/domains/financial/scripts/daily-analysis.sh" "$@"
