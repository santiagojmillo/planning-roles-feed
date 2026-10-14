#!/usr/bin/env bash
# job-radar: collect live (≤RADAR_DAYS-day, default 3) planning roles from free sources.
# Expects a career-ops checkout at $CO_DIR (default ./career-ops) with node_modules.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CO="$(cd "${CO_DIR:-$ROOT/career-ops}" && pwd)"
SWEEP_ATS="${RADAR_SWEEP_ATS:-greenhouse lever ashby workday icims}"
SWEEP_MIN="${RADAR_SWEEP_MINUTES:-20}"   # default cap per ATS (matches are only written when a pass finishes)
SLOW_MIN="${RADAR_SLOW_MINUTES:-90}"     # Workday / iCIMS directories are large
export RADAR_DAYS="${RADAR_DAYS:-3}"               # freshness window: scanners (--since) + collectors/build (env)
export RADAR_MAX_DETAIL="${RADAR_MAX_DETAIL:-150}" # cap on per-posting detail fetches, passed through to child processes
mkdir -p "$ROOT/logs" "$ROOT/tmp" "$ROOT/state" "$ROOT/out"

cp "$ROOT/config/portals.yml" "$CO/portals.yml"
mkdir -p "$CO/data"
[ -f "$ROOT/state/scan-history.tsv" ] && cp "$ROOT/state/scan-history.tsv" "$CO/data/scan-history.tsv"
printf '# Pipeline\n\n## Pending\n\n## Processed\n' > "$CO/data/pipeline.md"

echo "== tracked boards"; (cd "$CO" && node scan.mjs --since "$RADAR_DAYS") > "$ROOT/logs/scan.log" 2>&1; tail -3 "$ROOT/logs/scan.log"
: > "$ROOT/logs/sweep.log"; : > "$ROOT/logs/sweep-summary.log"
for ats in $SWEEP_ATS; do
  start=$(date +%s); cap=$SWEEP_MIN; case "$ats" in workday|icims) cap=$SLOW_MIN;; esac
  (cd "$CO" && timeout "${cap}m" node scan-ats-full.mjs --since "$RADAR_DAYS" --ats "$ats") >> "$ROOT/logs/sweep.log" 2>&1
  code=$?
  echo "sweep $ats: exit $code in $(( $(date +%s) - start ))s$([ $code -eq 124 ] && echo ' (TIMED OUT — matches from this ATS lost)')" | tee -a "$ROOT/logs/sweep-summary.log"
done
cp "$CO/data/scan-history.tsv" "$ROOT/state/scan-history.tsv" 2>/dev/null

echo "== linkedin"; node "$ROOT/radar/collect-linkedin.mjs" > "$ROOT/tmp/linkedin.json" 2> "$ROOT/logs/linkedin.log"; cat "$ROOT/logs/linkedin.log"
echo "== boards"; node "$ROOT/radar/collect-boards.mjs" > "$ROOT/tmp/boards.json" 2> "$ROOT/logs/boards.log"; cat "$ROOT/logs/boards.log"
if [ "${RADAR_GOOGLE_PRECOLLECTED:-}" = "1" ]; then
  # The workflow runs the collector in its own step (the only one with the token); never re-run it here without one.
  echo "== google (collected in its own workflow step)"; cat "$ROOT/logs/google.log" 2>/dev/null
  [ -s "$ROOT/tmp/google.json" ] || echo '{"stats":{"skipped":"the Google step produced no output — see its log"},"jobs":[],"feed_posts":[]}' > "$ROOT/tmp/google.json"
else
  echo "== google"; node "$ROOT/radar/collect-google.mjs" > "$ROOT/tmp/google.json" 2> "$ROOT/logs/google.log"; cat "$ROOT/logs/google.log"
fi
echo "== build"; node "$ROOT/radar/build.mjs" "$CO"
echo "== latest.md"; head -3 "$ROOT/out/latest.md" 2>/dev/null || echo "out/latest.md missing"
