#!/usr/bin/env bash
# tests/heavy/pg_upgrade_matrix.sh
# Schema-migration walk-forward matrix. For each "historical shape," build the
# fixture, then run `gbrain doctor` and assert it reaches LATEST cleanly.
#
# This exercises the bootstrap → SCHEMA_SQL → runMigrations path against
# real Postgres (the pre-existing test/e2e/postgres-bootstrap.test.ts covers
# the engine-level case; this matrix runs it end-to-end via the CLI shell
# under multiple simulated historical brain shapes).
#
# Why the matrix matters: the 10+ forward-reference bugs documented in
# CLAUDE.md (#239/#243/#266/#357/#366/#374/#375/#378/#395/#396) all shipped
# because a new release added a column-with-index in the schema blob without
# the corresponding bootstrap probe. Walking forward from multiple legacy
# shapes catches the next member of that bug class before users hit it.
#
# Honest contract (smoke-tested 2026-05-19): this matrix catches whole-system
# wedges, not single-layer bootstrap regressions. gbrain has a multi-layer
# defense (bootstrap → SCHEMA_SQL replay → migrations → verifySchema), and
# any one layer can heal what an upstream layer misses. We verified that
# stubbing out `applyForwardReferenceBootstrap` entirely still produces a
# clean walk-forward on both shapes — the downstream layers cover it. The
# matrix detects: (a) a regression that breaks ALL repair layers for a given
# column, (b) genuine wedge bugs where a hard SQL error escapes every layer,
# (c) timeouts in the walk-forward path. Single-layer regressions are caught
# by `test/schema-bootstrap-coverage.test.ts` (static) and
# `test/e2e/postgres-bootstrap.test.ts` (engine-level).
#
# Usage:
#   DATABASE_URL=postgresql://... ./tests/heavy/pg_upgrade_matrix.sh
#
# Or via the runner: bun run test:heavy

set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[pg_upgrade_matrix] DATABASE_URL not set; skipping (informational)." >&2
  echo "  Local: docker run -d --name gbrain-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gbrain_test -p 5434:5432 pgvector/pgvector:pg16" >&2
  echo "  Then: export DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test" >&2
  exit 0
fi

# Audit log path
TS=$(date -u +%Y%m%d-%H%M%SZ)
LOG_DIR="${GBRAIN_HOME:-$HOME/.gbrain}/audit"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/heavy-pg_upgrade_matrix-${TS}.log"

# Each entry runs build_legacy_fixtures.sh <shape> + gbrain doctor.
SHAPES=(pre-v0.13 pre-v0.18)

echo "[pg_upgrade_matrix] running ${#SHAPES[@]} shape(s): ${SHAPES[*]}"
echo "[pg_upgrade_matrix] log=$LOG_FILE"
echo ""

fails=0
for SHAPE in "${SHAPES[@]}"; do
  echo "[pg_upgrade_matrix] --- shape=$SHAPE ---" | tee -a "$LOG_FILE"

  # Step 1: build the legacy fixture (drop schema, init to LATEST, down-mutate)
  set +e
  timeout 180s bash tests/heavy/_build_legacy_fixtures.sh "$SHAPE" >> "$LOG_FILE" 2>&1
  BUILD_RC=$?
  set -e
  if [ "$BUILD_RC" -ne 0 ]; then
    echo "[pg_upgrade_matrix] FAIL: build_legacy_fixtures.sh $SHAPE exited $BUILD_RC (see $LOG_FILE)" >&2
    fails=$((fails + 1))
    continue
  fi

  # Step 2: walk forward. `gbrain doctor` triggers engine.connect() which
  # runs applyForwardReferenceBootstrap → SCHEMA_SQL → runMigrations.
  # Wedges manifest as either a timeout, a non-zero exit, or status != 'ok'
  # in the JSON output.
  DOCTOR_OUT="$LOG_DIR/heavy-pg_upgrade_doctor-${TS}-${SHAPE}.json"
  set +e
  timeout 120s bun run src/cli.ts doctor --json > "$DOCTOR_OUT" 2>>"$LOG_FILE"
  DOCTOR_RC=$?
  set -e
  if [ "$DOCTOR_RC" -ne 0 ]; then
    echo "[pg_upgrade_matrix] FAIL: doctor on $SHAPE exited $DOCTOR_RC (see $LOG_FILE + $DOCTOR_OUT)" >&2
    fails=$((fails + 1))
    continue
  fi

  # Step 3: assert status is non-fatal. We accept 'ok' and 'warnings' because
  # a freshly walked-forward brain may have legitimate warnings (zero pages,
  # no embeddings, etc) that are not wedge-class failures. We do NOT accept
  # 'fail' or 'failures' (gbrain doctor's terminal-failure shape).
  STATUS=$(grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]+"' "$DOCTOR_OUT" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  case "$STATUS" in
    ok|warn|warnings)
      echo "[pg_upgrade_matrix] OK: shape=$SHAPE → status=$STATUS" | tee -a "$LOG_FILE"
      ;;
    fail|failures|failed|"")
      echo "[pg_upgrade_matrix] FAIL: shape=$SHAPE doctor reported status='$STATUS' (see $DOCTOR_OUT)" >&2
      fails=$((fails + 1))
      ;;
    *)
      echo "[pg_upgrade_matrix] FAIL: shape=$SHAPE unexpected doctor status='$STATUS' (see $DOCTOR_OUT)" >&2
      fails=$((fails + 1))
      ;;
  esac

  echo "" | tee -a "$LOG_FILE"
done

if [ "$fails" -gt 0 ]; then
  echo "[pg_upgrade_matrix] FAILED: $fails/${#SHAPES[@]} shape(s) wedged on walk-forward." >&2
  echo "[pg_upgrade_matrix] Full log: $LOG_FILE" >&2
  exit 1
fi

echo "[pg_upgrade_matrix] OK — all ${#SHAPES[@]} shape(s) walked forward cleanly."
