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

# Step 4: build the runner-side E2E command. Either parallel (4 shards) or
# debug-sequential (--no-shard).
if [ "$NO_SHARD" = "1" ]; then
  if [ "$DIFF" = "1" ]; then
    RUN_E2E_CMD='SELECTED=$(bun run scripts/select-e2e.ts) && if [ -z "$SELECTED" ]; then echo "[ci-local] selector emitted nothing (doc-only diff); skipping E2E."; else echo "$SELECTED" | xargs bash scripts/run-e2e.sh; fi'
  else
    RUN_E2E_CMD='bash scripts/run-e2e.sh'
  fi
else
  # Sharded: each shard pinned to its own postgres service. xargs -P4 fans out.
  # Each shard writes to its own log file so output isn't tangled; we cat the
  # logs in shard order at the end.
  if [ "$DIFF" = "1" ]; then
    SELECT_PREFIX='SELECTED=$(bun run scripts/select-e2e.ts) && '
    DISPATCH='if [ -z "$SELECTED" ]; then echo "[ci-local] selector emitted nothing (doc-only diff); skipping E2E."; exit 0; fi && echo "$SELECTED" | tr " " "\n" > /tmp/e2e-selected.txt && '
    SHARD_RUN='cat /tmp/e2e-selected.txt | xargs -r bash scripts/run-e2e.sh'
  else
    SELECT_PREFIX=''
    DISPATCH=''
    SHARD_RUN='bash scripts/run-e2e.sh'
  fi
  RUN_E2E_CMD="${SELECT_PREFIX}${DISPATCH}mkdir -p /tmp/e2e-shard-logs && \
seq 1 4 | xargs -n1 -P4 -I{} sh -c '
  SHARD={}/4 \
  DATABASE_URL=postgresql://postgres:postgres@postgres-{}:5432/gbrain_test \
  ${SHARD_RUN} > /tmp/e2e-shard-logs/shard-{}.log 2>&1
  echo \"[shard {} done] exit=\$?\"
' && \
echo \"\" && echo \"=== SHARD LOGS ===\" && \
for s in 1 2 3 4; do echo \"--- shard \$s ---\" && cat /tmp/e2e-shard-logs/shard-\$s.log; done"
fi

INNER_CMD=$(cat <<'EOF'
set -euo pipefail
echo "[runner] bun version: $(bun --version)"
# oven/bun:1 omits git; many unit tests use mkdtemp + git init for fixtures.
# Install at startup; ~5s amortized per run. Cheaper than baking a Dockerfile.
if ! command -v git >/dev/null 2>&1; then
  echo "[runner] Installing git (debian apt)..."
  apt-get update -qq >/dev/null
  apt-get install -y -qq git ca-certificates >/dev/null
fi
# Container runs as root (uid 0) against a host-uid bind-mount; mark the
# repo + any worktree gitdir as safe so `git status` etc. don't refuse.
git config --global --add safe.directory '*' || true
if [ ! -d /app/node_modules ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo "[runner] First run (or --clean): bun install --frozen-lockfile"
  bun install --frozen-lockfile
fi
# Match GH Actions structure: unit job has NO DATABASE_URL (so test/e2e/*
# files skip via hasDatabase() at the top); E2E job sets DATABASE_URL per
# shard via the run-e2e.sh dispatcher below. Without unset here, e2e tests
# would run twice — once parallel-and-broken in unit phase, once correctly
# in the sharded E2E phase.
echo "[runner] bun run test (unit only — DATABASE_URL unset)"
env -u DATABASE_URL bun run test
echo "[runner] E2E (sharded 4-way, parallel)"
__RUN_E2E__
EOF
)

INNER_CMD="${INNER_CMD//__RUN_E2E__/$RUN_E2E_CMD}"

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
