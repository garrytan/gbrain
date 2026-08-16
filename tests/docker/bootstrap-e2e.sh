#!/usr/bin/env bash
# tests/docker/bootstrap-e2e.sh — offline (networkless) agent-bootstrap e2e
# harness [A7]. This is the script .github/workflows/heavy-tests.yml's
# placeholder step gates on; it also runs locally:
#
#   bash tests/docker/bootstrap-e2e.sh            # build + run (needs docker)
#   bash tests/docker/bootstrap-e2e.sh --dry-run  # validate scripts, no docker
#
# Build phase HAS network (base image + bun install). The test container is
# then run cold-machine-shaped:
#   --network none --read-only --cap-drop ALL --tmpfs /tmp
# and executes tests/docker/bootstrap-e2e-inner.sh: scripted interview →
# confirm → render → fake-gh repo phase → ABORT_AFTER kill + status resume →
# keyless verify on a temp PGLite brain.
#
# Env knobs:
#   GBRAIN_E2E_BUN_IMAGE   base image override (default oven/bun:1.3.13 —
#                          keep in step with heavy-tests.yml's bun-version)
#   GBRAIN_E2E_IMAGE_TAG   image tag override (default gbrain-bootstrap-e2e:local)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INNER="$SCRIPT_DIR/bootstrap-e2e-inner.sh"
DOCKERFILE="$SCRIPT_DIR/Dockerfile"
BUN_IMAGE="${GBRAIN_E2E_BUN_IMAGE:-oven/bun:1.3.13}"
IMAGE_TAG="${GBRAIN_E2E_IMAGE_TAG:-gbrain-bootstrap-e2e:local}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown flag: $arg (supported: --dry-run, --help)" >&2
      exit 2 ;;
  esac
done

# ── Static validation (always; the whole job under --dry-run) ────────────────
bash -n "$0" || { echo "FAIL: $0 does not parse" >&2; exit 1; }
bash -n "$INNER" || { echo "FAIL: $INNER does not parse" >&2; exit 1; }
[ -f "$DOCKERFILE" ] || { echo "FAIL: missing $DOCKERFILE" >&2; exit 1; }
echo "[bootstrap-e2e] scripts parse; Dockerfile present"

RUN_ARGS=(
  --rm
  --network none
  --read-only
  --cap-drop ALL
  --tmpfs /tmp:rw,exec,size=1024m
  -e HOME=/tmp/home
  -e GBRAIN_HOME=/tmp/gb
  -e TMPDIR=/tmp
  -e GBRAIN_SKIP_STARTUP_HOOKS=1
  "$IMAGE_TAG"
  bash /app/tests/docker/bootstrap-e2e-inner.sh
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[bootstrap-e2e] DRY RUN — would execute:"
  echo "  DOCKER_BUILDKIT=1 docker build --build-arg BUN_IMAGE=$BUN_IMAGE -f $DOCKERFILE -t $IMAGE_TAG $REPO_ROOT"
  echo "  docker run ${RUN_ARGS[*]}"
  if command -v docker > /dev/null 2>&1; then
    echo "[bootstrap-e2e] docker IS available here — rerun without --dry-run for the real thing"
  else
    echo "[bootstrap-e2e] docker is NOT available in this environment"
  fi
  exit 0
fi

command -v docker > /dev/null 2>&1 || {
  echo "FAIL: docker is required (or use --dry-run for validation only)" >&2
  exit 1
}
docker info > /dev/null 2>&1 || {
  echo "FAIL: docker CLI is present but the daemon is not reachable — start it," >&2
  echo "      or use --dry-run; the same flow can also be smoke-run without docker" >&2
  echo "      (see the header of tests/docker/bootstrap-e2e-inner.sh)." >&2
  exit 1
}

echo "[bootstrap-e2e] building $IMAGE_TAG (network available during build only)"
DOCKER_BUILDKIT=1 docker build \
  --build-arg "BUN_IMAGE=$BUN_IMAGE" \
  -f "$DOCKERFILE" \
  -t "$IMAGE_TAG" \
  "$REPO_ROOT"

echo "[bootstrap-e2e] running networkless container (--network none --read-only --cap-drop ALL --tmpfs /tmp)"
docker run "${RUN_ARGS[@]}"

echo "[bootstrap-e2e] PASS"
