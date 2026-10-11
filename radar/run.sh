#!/usr/bin/env bash
# job-radar: collect live (≤3-day) planning roles from free sources.
# Expects a career-ops checkout at $CO_DIR (default ./career-ops) with node_modules.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CO="$(cd "${CO_DIR:-$ROOT/career-ops}" && pwd)"
SWEEP_ATS="${RADAR_SWEEP_ATS:-greenhouse lever ashby workday icims}"
SWEEP_MIN="${RADAR_SWEEP_MINUTES:-20}"   # cap per ATS (matches are only written when a pass finishes)
mkdir -p "$ROOT/logs" "$ROOT/tmp" "$ROOT/state" "$ROOT/out"

cp "$ROOT/config/portals.yml" "$CO/portals.yml"
mkdir -p "$CO/data"
[ -f "$ROOT/state/scan-history.tsv" ] && cp "$ROOT/state/scan-history.tsv" "$CO/data/scan-history.tsv"
printf '# Pipeline\n\n## Pending\n\n## Processed\n' > "$CO/data/pipeline.md"

echo "== tracked boards"; (cd "$CO" && node scan.mjs --since 3) > "$ROOT/logs/scan.log" 2>&1; tail -3 "$ROOT/logs/scan.log"
: > "$ROOT/logs/sweep.log"; : > "$ROOT/logs/sweep-summary.log"
for ats in $SWEEP_ATS; do
  start=$(date +%s)
  (cd "$CO" && timeout "${SWEEP_MIN}m" node scan-ats-full.mjs --since 3 --ats "$ats") >> "$ROOT/logs/sweep.log" 2>&1
  code=$?
  echo "sweep $ats: exit $code in $(( $(date +%s) - start ))s$([ $code -eq 124 ] && echo ' (TIMED OUT — matches from this ATS lost)')" | tee -a "$ROOT/logs/sweep-summary.log"
done
cp "$CO/data/scan-history.tsv" "$ROOT/state/scan-history.tsv" 2>/dev/null

echo "== linkedin"; node "$ROOT/radar/collect-linkedin.mjs" > "$ROOT/tmp/linkedin.json" 2> "$ROOT/logs/linkedin.log"; cat "$ROOT/logs/linkedin.log"
echo "== boards"; node "$ROOT/radar/collect-boards.mjs" > "$ROOT/tmp/boards.json" 2> "$ROOT/logs/boards.log"; cat "$ROOT/logs/boards.log"
echo "== build"; node "$ROOT/radar/build.mjs" "$CO"
