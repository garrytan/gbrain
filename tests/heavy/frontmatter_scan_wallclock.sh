#!/usr/bin/env bash
# tests/heavy/frontmatter_scan_wallclock.sh
# Wall-clock smoke for the v0.38.2.0 doctor frontmatter-scan production fix.
#
# Reproduces the load case from PR #1287 (which this PR supersedes) at a
# scale where the bug actually shows: a brain with N "real" markdown pages
# under regular subdirs PLUS M dummy pages under node_modules/. Pre-v0.38.2.0
# the walker descended into node_modules and paid the IO cost of stat'ing
# every entry; with N+M ≈ 60K the scan would hang past doctor's default
# 30s budget.
#
# Asserts post-v0.38.2.0:
#   1. `gbrain doctor` exits 0 OR 1 (some warns OK), NOT killed by timeout.
#   2. frontmatter_integrity status is `ok` (clean prefix, no partial), NOT `warn`.
#   3. Total wall-clock under WALLCLOCK_BUDGET_S (default 15s).
#
# Why N+M=60K (not 200K like the original report): 60K is the smallest
# fixture size where descent-into-node_modules adds at least 5s of wall-clock
# (~50K extra stat calls on a modern SSD); above that, it scales linearly.
# Beating 200K would be cleaner but takes ~30s to seed the fixture, which is
# the line between "heavy test" and "torture test." If a future contributor
# needs the larger fixture, just bump REAL_PAGES + NODE_MODULES_PAGES.
#
# Codex outside-voice C7 caught the original plan's 1500-file E2E budget:
# at that scale the test passes BEFORE AND AFTER the fix, proving nothing.
# This script's 60K-file budget is the minimum that catches the regression.
#
# Works on either PGLite (default, no DATABASE_URL required) or Postgres
# (set DATABASE_URL to test the Postgres SQL paths).

set -euo pipefail

cd "$(dirname "$0")/../.."

WALLCLOCK_BUDGET_S="${WALLCLOCK_BUDGET_S:-15}"
REAL_PAGES="${REAL_PAGES:-10000}"
NODE_MODULES_PAGES="${NODE_MODULES_PAGES:-50000}"

TS=$(date -u +%Y%m%d-%H%M%SZ)
# Isolate from the developer's real ~/.gbrain. Each run uses a fresh tmpdir.
TMP_GBRAIN_HOME=$(mktemp -d -t gbrain-fm-wallclock-home-XXXXXX)
export GBRAIN_HOME="$TMP_GBRAIN_HOME"
BRAIN_DIR=$(mktemp -d -t gbrain-fm-wallclock-brain-XXXXXX)
LOG_DIR="$GBRAIN_HOME/audit"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/heavy-frontmatter_scan_wallclock-$TS.log"
SURFACE_LOG="${TMPDIR:-/tmp}/heavy-frontmatter_scan_wallclock-$TS.log"
trap 'cp -f "$LOG" "$SURFACE_LOG" 2>/dev/null || true; rm -rf "$TMP_GBRAIN_HOME" "$BRAIN_DIR"' EXIT

echo "[fm_wallclock] log=$LOG"
echo "[fm_wallclock] brain=$BRAIN_DIR (real_pages=$REAL_PAGES node_modules_pages=$NODE_MODULES_PAGES)"
echo "[fm_wallclock] wallclock_budget=${WALLCLOCK_BUDGET_S}s"

# Step 1: seed the synthetic brain.
echo "[fm_wallclock] seeding fixture..." | tee -a "$LOG"
SEED_START=$SECONDS

mkdir -p "$BRAIN_DIR/people" "$BRAIN_DIR/concepts" "$BRAIN_DIR/node_modules/fake-pkg"

# Real syncable pages: split across two regular subdirs so the walker has
# work to do on the legitimate side too.
half_real=$((REAL_PAGES / 2))
for i in $(seq 1 "$half_real"); do
  printf -- '---\ntitle: Person %s\n---\n\nbody\n' "$i" \
    > "$BRAIN_DIR/people/p$i.md"
done
remainder_real=$((REAL_PAGES - half_real))
for i in $(seq 1 "$remainder_real"); do
  printf -- '---\ntitle: Concept %s\n---\n\nbody\n' "$i" \
    > "$BRAIN_DIR/concepts/c$i.md"
done

# Vendor pages under node_modules/. Pre-v0.38.2.0 walker descended here and
# stat'd every one. Post-fix the walker prunes at the node_modules boundary.
for i in $(seq 1 "$NODE_MODULES_PAGES"); do
  printf '# README %s\n' "$i" > "$BRAIN_DIR/node_modules/fake-pkg/r$i.md"
done
SEED_ELAPSED=$((SECONDS - SEED_START))
echo "[fm_wallclock] fixture seeded in ${SEED_ELAPSED}s" | tee -a "$LOG"

# Step 2: init brain + register the source.
# `--no-embedding` opts out of the embedding-provider hard-require (v0.37 D9).
# This script measures doctor's frontmatter-scan wallclock — it never embeds —
# so the CI runner doesn't need OPENAI_API_KEY / ZEROENTROPY_API_KEY / VOYAGE_API_KEY.
echo "[fm_wallclock] init brain..." | tee -a "$LOG"
timeout 120s bun run src/cli.ts init --pglite --yes --no-embedding >> "$LOG" 2>&1 || {
  echo "[fm_wallclock] FAIL: gbrain init exited non-zero" >&2
  echo "Log tail:" >&2
  tail -30 "$LOG" >&2
  exit 1
}

# Register the brain dir as a source. Use raw SQL since `gbrain sources add`
# might not exist in this version-window; the schema is what doctor reads.
echo "[fm_wallclock] register source..." | tee -a "$LOG"
bun run -e "
import { PGLiteEngine } from './src/core/pglite-engine.ts';
const e = new PGLiteEngine();
await e.connect({});
await e.initSchema();
await e.executeRaw(
  \"INSERT INTO sources (id, name, local_path) VALUES ('fm-wallclock', 'Frontmatter wallclock test', \\\$1)\",
  ['$BRAIN_DIR'],
);
await e.disconnect();
console.log('source registered');
" 2>&1 | tee -a "$LOG"

# Step 3: run gbrain doctor; capture wall-clock + exit + frontmatter_integrity status.
echo "[fm_wallclock] running gbrain doctor (budget ${WALLCLOCK_BUDGET_S}s)..." | tee -a "$LOG"
DOCTOR_START_NS=$(date +%s%N)
set +e
timeout "${WALLCLOCK_BUDGET_S}s" bun run src/cli.ts doctor --json > "$LOG.doctor" 2>>"$LOG"
DOCTOR_RC=$?
set -e
DOCTOR_END_NS=$(date +%s%N)
DOCTOR_MS=$(( (DOCTOR_END_NS - DOCTOR_START_NS) / 1000000 ))
echo "[fm_wallclock] doctor exit=$DOCTOR_RC wallclock=${DOCTOR_MS}ms" | tee -a "$LOG"

# Step 4: assert.
# RC 124 = `timeout` killed it. Other non-zero = doctor warns/fails, also FYI
# but allowed for unrelated reasons. The load-bearing assertion is the
# frontmatter_integrity status from the JSON.
if [ "$DOCTOR_RC" = "124" ]; then
  echo "[fm_wallclock] FAIL: doctor exceeded ${WALLCLOCK_BUDGET_S}s budget — the v0.38.2.0 pruneDir wiring is broken" >&2
  echo "  Log tail:" >&2
  tail -30 "$LOG" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[fm_wallclock] WARN: jq not installed; skipping JSON-shape assertion" >&2
  echo "[fm_wallclock] PASS (wall-clock check passed; JSON assertion skipped)" | tee -a "$LOG"
  exit 0
fi

FM_STATUS=$(jq -r '.checks[] | select(.name=="frontmatter_integrity") | .status' "$LOG.doctor")
FM_MSG=$(jq -r '.checks[] | select(.name=="frontmatter_integrity") | .message' "$LOG.doctor")
echo "[fm_wallclock] frontmatter_integrity: status=$FM_STATUS msg=$FM_MSG" | tee -a "$LOG"

if [ "$FM_STATUS" != "ok" ]; then
  # Pre-v0.38.2.0 would either timeout (caught above) or report PARTIAL when
  # the walker actually got into node_modules and ran out of budget. Either
  # is a regression.
  echo "[fm_wallclock] FAIL: frontmatter_integrity is not ok (got: $FM_STATUS)" >&2
  echo "  Either the deadline fired (Fix 1 / pruneDir is broken) or the walk hit unexpected errors." >&2
  exit 1
fi

echo "[fm_wallclock] PASS (doctor=${DOCTOR_MS}ms < ${WALLCLOCK_BUDGET_S}s budget, frontmatter_integrity=ok)" | tee -a "$LOG"
