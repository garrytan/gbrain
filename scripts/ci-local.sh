#!/usr/bin/env bash
# scripts/ci-local.sh
#
# Local CI gate. Runs the same checks GH Actions does (and a stricter superset
# of E2E) inside Docker. See docker-compose.ci.yml.
#
# Modes:
#   bash scripts/ci-local.sh              # full local gate: gitleaks + unit + ALL E2E (4-way sharded)
#   bash scripts/ci-local.sh --diff       # full local gate: gitleaks + unit + selected E2E (4-way sharded)
#   bash scripts/ci-local.sh --no-pull    # skip docker compose pull (offline / debug)
#   bash scripts/ci-local.sh --clean      # nuke named volumes for cold debug
#   bash scripts/ci-local.sh --no-shard   # debug: run E2E sequentially against postgres-1 only
#
# 4-way E2E sharding: 4 pgvector services on host ports 5434-5437. The 36 E2E
# files split N/4 per shard; shards run in parallel. Within a shard, files run
# sequentially (TRUNCATE CASCADE no-race property documented in run-e2e.sh).
# Wall-time on a 16-core host: ~6 min sequential -> ~1.5-2 min sharded.
#
# Stronger than PR CI: PR CI runs only Tier 1's 2 files; this runs all 36.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.ci.yml"

DIFF=0
NO_PULL=0
CLEAN=0
NO_SHARD=0

for arg in "$@"; do
  case "$arg" in
    --diff) DIFF=1 ;;
    --no-pull) NO_PULL=1 ;;
    --clean) CLEAN=1 ;;
    --no-shard) NO_SHARD=1 ;;
    *)
      echo "Usage: $0 [--diff] [--no-pull] [--clean] [--no-shard]" >&2
      exit 1
      ;;
  esac
done

cleanup() {
  echo ""
  echo "[ci-local] Tearing down postgres..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tail -5 || true
}
trap cleanup EXIT

if [ "$CLEAN" = "1" ]; then
  echo "[ci-local] --clean: removing named volumes..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>&1 | tail -5 || true
fi

# Tier 2: --diff fast-path. If the diff is doc-only (or empty), skip the
# whole heavy gate (postgres + bun install + unit + E2E) and just verify
# gitleaks on host. Doc-only diffs go from ~25 min to ~5 seconds.
if [ "$DIFF" = "1" ]; then
  CLASSIFICATION=$(bun run scripts/select-e2e.ts --classify-only 2>/dev/null || echo "ERR")
  case "$CLASSIFICATION" in
    DOC_ONLY)
      echo "[ci-local] --diff: diff is doc-only — skipping postgres + unit + E2E (Tier 2 fast-path)."
      echo "[ci-local] Running gitleaks on host as the only gate..."
      if ! command -v gitleaks >/dev/null 2>&1; then
        echo "[ci-local] WARN: gitleaks not installed; skipping. brew install gitleaks." >&2
      else
        gitleaks dir . --redact --no-banner
        gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"
      fi
      echo "[ci-local] Doc-only fast-path complete. No code paths exercised."
      trap - EXIT
      exit 0
      ;;
    EMPTY)
      echo "[ci-local] --diff: diff is empty (clean branch) — running full gate per fail-closed contract."
      ;;
    SRC)
      echo "[ci-local] --diff: diff touches src/ — running selected E2E + full unit phase."
      ;;
    *)
      echo "[ci-local] WARN: select-e2e.ts --classify-only returned '$CLASSIFICATION' — running full gate." >&2
      ;;
  esac
fi

# Pre-flight: postgres host ports for 4 shards. Defaults to 5434-5437 (avoid
# 5432 manual gbrain-test-pg, 5433 commonly held by sibling projects).
# GBRAIN_CI_PG_PORT defines BASE; shards take BASE..BASE+3.
PG_PORT_BASE="${GBRAIN_CI_PG_PORT:-5434}"
for shard in 1 2 3 4; do
  port=$((PG_PORT_BASE + shard - 1))
  PORT_OWNER=$(docker ps --filter "publish=$port" --format "{{.Names}}" | head -1)
  if [ -n "$PORT_OWNER" ]; then
    echo "[ci-local] ERROR: host port $port (shard $shard) is already used by docker container '$PORT_OWNER'." >&2
    echo "[ci-local] Either stop that container or run with: GBRAIN_CI_PG_PORT=NNNN bun run ci:local" >&2
    exit 1
  fi
  if lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    echo "[ci-local] ERROR: host port $port (shard $shard) is held by a non-docker process." >&2
    echo "[ci-local] Run with: GBRAIN_CI_PG_PORT=NNNN bun run ci:local" >&2
    exit 1
  fi
done
export GBRAIN_CI_PG_PORT="$PG_PORT_BASE"
export GBRAIN_CI_PG_PORT_2=$((PG_PORT_BASE + 1))
export GBRAIN_CI_PG_PORT_3=$((PG_PORT_BASE + 2))
export GBRAIN_CI_PG_PORT_4=$((PG_PORT_BASE + 3))

# Step 0: gitleaks on the host (no docker, no postgres, no bun needed).
# Mirrors test.yml's separate gitleaks job. Fail loudly if not installed.
echo "[ci-local] gitleaks detect (host)..."
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[ci-local] ERROR: gitleaks not installed on host." >&2
  echo "[ci-local]   macOS:  brew install gitleaks" >&2
  echo "[ci-local]   Linux:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi
# Two scopes for pre-push:
#   1. Working-tree files (catch uncommitted secrets sitting in files)
#   2. Branch commits vs origin/master (catch secrets committed on this branch)
# Full-history scan is ~4 min on this repo's 3700+ commits; not useful pre-push.
gitleaks dir . --redact --no-banner
gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"

# Step 1: pull. Refreshes pgvector + oven/bun:1 (both are `image:` not `build:`).
if [ "$NO_PULL" = "0" ]; then
  echo "[ci-local] Pulling base images (use --no-pull to skip)..."
  docker compose -f "$COMPOSE_FILE" pull 2>&1 | tail -5
fi

# Step 2: 4 postgres shards up + wait for healthy.
echo "[ci-local] Starting 4 postgres shards..."
docker compose -f "$COMPOSE_FILE" up -d postgres-1 postgres-2 postgres-3 postgres-4
echo "[ci-local] Waiting for all 4 postgres shards healthy..."
for i in {1..40}; do
  all_healthy=1
  for shard in 1 2 3 4; do
    status=$(docker compose -f "$COMPOSE_FILE" ps --format json postgres-$shard 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 | sed 's/.*":"//;s/"//')
    if [ "$status" != "healthy" ]; then
      all_healthy=0
      break
    fi
  done
  if [ "$all_healthy" = "1" ]; then
    echo "[ci-local] All 4 postgres shards healthy."
    break
  fi
  if [ "$i" = "40" ]; then
    echo "[ci-local] ERROR: not all postgres shards became healthy in 40 attempts" >&2
    exit 1
  fi
  sleep 1
done

# Step 3: smoke-test run-e2e.sh argv + shard handling.
echo "[ci-local] Smoke: run-e2e.sh argv + shard..."
SMOKE_NO_ARGS=$(bash scripts/run-e2e.sh --dry-run-list | wc -l | tr -d ' ')
EXPECTED_ALL=$(ls test/e2e/*.test.ts | wc -l | tr -d ' ')
if [ "$SMOKE_NO_ARGS" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: --dry-run-list (no args) printed $SMOKE_NO_ARGS, expected $EXPECTED_ALL" >&2
  exit 1
fi
SMOKE_ONE_ARG=$(bash scripts/run-e2e.sh --dry-run-list test/e2e/sync.test.ts)
if [ "$SMOKE_ONE_ARG" != "test/e2e/sync.test.ts" ]; then
  echo "[ci-local] ERROR: --dry-run-list with 1 arg printed '$SMOKE_ONE_ARG'" >&2
  exit 1
fi
SHARD_TOTAL=$(( $(SHARD=1/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=2/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=3/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=4/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) ))
if [ "$SHARD_TOTAL" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: shards 1-4 covered $SHARD_TOTAL files, expected $EXPECTED_ALL" >&2
  exit 1
fi
echo "[ci-local] Smoke OK ($SMOKE_NO_ARGS files no-arg, 1 single-arg, ${SHARD_TOTAL}=4-shard total)."

# Step 4: build the runner-side command.
# Tier 1: 4-shard parallel UNIT + E2E. Each shard runs ~46 unit files + ~9
# E2E files against postgres-N. Guards + typecheck run ONCE before fan-out.
# --no-shard runs the legacy unsharded flow (debug aid).
if [ "$NO_SHARD" = "1" ]; then
  if [ "$DIFF" = "1" ]; then
    RUN_PHASES_CMD='echo "[runner] guards + typecheck"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo "[runner] unit (unsharded, DATABASE_URL unset)"
env -u DATABASE_URL bash scripts/run-unit-shard.sh
echo "[runner] e2e (unsharded, --diff selected)"
SELECTED=$(bun run scripts/select-e2e.ts)
if [ -z "$SELECTED" ]; then
  echo "[runner] selector emitted nothing (doc-only diff); skipping E2E."
else
  DATABASE_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test echo "$SELECTED" | xargs bash scripts/run-e2e.sh
fi'
  else
    RUN_PHASES_CMD='echo "[runner] guards + typecheck"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo "[runner] unit (unsharded, DATABASE_URL unset)"
env -u DATABASE_URL bash scripts/run-unit-shard.sh
echo "[runner] e2e (unsharded)"
DATABASE_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test bash scripts/run-e2e.sh'
  fi
else
  # Tier 1 sharded path. Each shard runs unit+E2E sequentially against its
  # own postgres-N. Shards run in parallel via xargs -P4.
  if [ "$DIFF" = "1" ]; then
    DIFF_E2E_PREP='SELECTED=$(bun run scripts/select-e2e.ts)
if [ -z "$SELECTED" ]; then
  echo "" > /tmp/e2e-selected.txt
else
  echo "$SELECTED" | tr " " "\n" | grep -v "^$" > /tmp/e2e-selected.txt
fi'
  else
    # Empty file -> run-e2e.sh uses default glob (all 36 E2E files).
    DIFF_E2E_PREP='> /tmp/e2e-selected.txt'
  fi
  RUN_PHASES_CMD="echo \"[runner] guards + typecheck (run once before sharding)\"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo \"[runner] Tier 3: building PGLite snapshot fixture (cached across reruns)\"
if [ ! -f test/fixtures/pglite-snapshot.tar ] || [ ! -f test/fixtures/pglite-snapshot.version ]; then
  bun run build:pglite-snapshot
else
  echo \"[runner] snapshot fixture exists; engine will validate hash at load time\"
fi
export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
echo \"[runner] resolving E2E file selection (--diff aware)\"
${DIFF_E2E_PREP}
mkdir -p /tmp/shard-logs
echo \"[runner] Tier 1: 4-shard parallel unit + E2E (xargs -P4)\"
set +e
printf '%s\\n' 1 2 3 4 | xargs -P4 -I{} sh -c '
  shard=\$1
  log=/tmp/shard-logs/shard-\${shard}.log
  echo \"[shard \${shard}] start\" > \$log
  echo \"[shard \${shard}] unit phase (SHARD=\${shard}/4, DATABASE_URL unset)\" >> \$log
  env -u DATABASE_URL SHARD=\${shard}/4 bash scripts/run-unit-shard.sh >> \$log 2>&1
  unit_exit=\$?
  if [ \$unit_exit -ne 0 ]; then
    echo \"[shard \${shard}] UNIT FAILED (exit=\$unit_exit)\" >> \$log
    exit \$unit_exit
  fi
  echo \"[shard \${shard}] e2e phase (SHARD=\${shard}/4, DATABASE_URL=postgres-\${shard})\" >> \$log
  if [ -s /tmp/e2e-selected.txt ]; then
    SHARD=\${shard}/4 \\
    DATABASE_URL=postgresql://postgres:postgres@postgres-\${shard}:5432/gbrain_test \\
    xargs -a /tmp/e2e-selected.txt bash scripts/run-e2e.sh >> \$log 2>&1
  else
    SHARD=\${shard}/4 \\
    DATABASE_URL=postgresql://postgres:postgres@postgres-\${shard}:5432/gbrain_test \\
    bash scripts/run-e2e.sh >> \$log 2>&1
  fi
  e2e_exit=\$?
  if [ \$e2e_exit -ne 0 ]; then
    echo \"[shard \${shard}] E2E FAILED (exit=\$e2e_exit)\" >> \$log
    exit \$e2e_exit
  fi
  echo \"[shard \${shard}] DONE\" >> \$log
' _ {}
shard_xargs_exit=\$?
set -e
echo \"\"
echo \"=== SHARD LOGS (last 30 lines each + unit/e2e summaries) ===\"
for s in 1 2 3 4; do
  echo \"\"
  echo \"--- shard \$s ---\"
  if [ -f /tmp/shard-logs/shard-\$s.log ]; then
    # Pull the unit + E2E summary lines explicitly so they survive even if
    # the file is huge. Match: bun's '<N> pass / <N> fail' pairs, run-e2e.sh's
    # 'Files: ... / Tests: ...' summary, and our own shard markers.
    grep -E '^\\[shard|^Files: |^Tests: |Ran [0-9]+ tests|^[[:space:]]+[0-9]+ (pass|fail|skip)\$' /tmp/shard-logs/shard-\$s.log || true
    echo \"  (last 30 lines for context)\"
    tail -30 /tmp/shard-logs/shard-\$s.log
  else
    echo \"(no log file written — shard never started)\"
  fi
done
echo \"\"
if [ \$shard_xargs_exit -ne 0 ]; then
  echo \"[runner] One or more shards failed (xargs exit=\$shard_xargs_exit). See SHARD LOGS above.\"
  exit \$shard_xargs_exit
fi
echo \"[runner] All 4 shards passed.\""
fi

INNER_CMD=$(cat <<'EOF'
set -euo pipefail
echo "[runner] bun version: $(bun --version)"
# oven/bun:1 omits git; many unit tests use mkdtemp + git init for fixtures.
if ! command -v git >/dev/null 2>&1; then
  echo "[runner] Installing git (debian apt)..."
  apt-get update -qq >/dev/null
  apt-get install -y -qq git ca-certificates >/dev/null
fi
# Container runs as root (uid 0) against a host-uid bind-mount; mark repo +
# any worktree gitdir as safe so `git status` etc. don't refuse.
git config --global --add safe.directory '*' || true
if [ ! -d /app/node_modules ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo "[runner] First run (or --clean): bun install --frozen-lockfile"
  bun install --frozen-lockfile
fi
__RUN_PHASES__
EOF
)
INNER_CMD="${INNER_CMD/__RUN_PHASES__/$RUN_PHASES_CMD}"

# Conductor / git-worktree support: when `.git` is a file (not a directory),
# it points at a host gitdir outside the bind-mount. Without remounting that
# path, scripts/check-trailing-newline.sh and any other in-container `git`
# call exits 128 ("not a git repository"). Resolve the host gitdir + the
# shared common gitdir and bind-mount them at the same absolute paths.
EXTRA_MOUNTS=()
if [ -f .git ]; then
  WORKTREE_GITDIR=$(awk '{print $2}' .git)
  if [ -d "$WORKTREE_GITDIR" ]; then
    COMMONDIR_FILE="$WORKTREE_GITDIR/commondir"
    if [ -f "$COMMONDIR_FILE" ]; then
      COMMON_REL=$(cat "$COMMONDIR_FILE")
      COMMON_GITDIR=$(cd "$WORKTREE_GITDIR" && cd "$COMMON_REL" && pwd)
    else
      COMMON_GITDIR="$WORKTREE_GITDIR"
    fi
    # Mount the higher-level common gitdir; covers worktrees/<name> automatically.
    EXTRA_MOUNTS+=( -v "${COMMON_GITDIR}:${COMMON_GITDIR}:ro" )
    echo "[ci-local] Worktree detected; mounting shared gitdir: $COMMON_GITDIR"
  fi
fi

echo "[ci-local] Running checks inside runner container..."
docker compose -f "$COMPOSE_FILE" run --rm "${EXTRA_MOUNTS[@]:-}" runner bash -c "$INNER_CMD"

echo ""
echo "[ci-local] All checks passed."
