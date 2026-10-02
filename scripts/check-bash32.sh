#!/usr/bin/env bash
# CI guard: every tracked shell script parses under bash 3.2.
#
# macOS still ships GNU bash 3.2.57 as /bin/bash, and its parser rejects
# shapes bash 5 accepts: a heredoc inside $(...) whose body has an odd quote
# made check-retired-phrases.sh unparseable there, so `bun run verify` failed
# on every Mac (#5810). This guard runs the real 3.2 parser (`bash -n`) over
# every tracked *.sh except the guard fixtures under test/fixtures/guards/.
# It checks parsing only; runtime bash-4 features are covered by the macOS 26
# job running `bun run verify` under /bin/bash.
#
# Parser, first available:
#   GBRAIN_BASH32=<path>  a bash 3.x binary
#   /bin/bash             when it is bash 3.x (stock macOS)
#   Docker image bash:3.2 (GNU bash 3.2.57, digest-pinned)
# GBRAIN_BASH32=docker forces the image. Without a parser the guard prints
# one skip line and exits 0, unless GBRAIN_BASH32_REQUIRE=1 (CI), which
# turns that into exit 2.
#
# Run: bun run check:bash32
# Wired into CI by test.yml (verify job) and macos-validation.yml; not in
# `bun run verify`, which must not need Docker.
# Seams: GBRAIN_GUARD_ROOT scans a fixture tree with find instead of
# git ls-files; GBRAIN_BASH32_DOCKER names the docker CLI.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 2
ROOT="$(pwd -P)"

IMAGE='bash:3.2@sha256:0fd7cb8499c63a3c9345e7088a9cd83bb69f6e895e83833859aff838a0312091'
DOCKER="${GBRAIN_BASH32_DOCKER:-docker}"
REQUIRE="${GBRAIN_BASH32_REQUIRE:-0}"

FILES=()
if [ -n "${GBRAIN_GUARD_ROOT:-}" ]; then
  while IFS= read -r -d '' f; do FILES+=("${f#./}"); done < <(find . -type f -name '*.sh' -print0)
else
  while IFS= read -r -d '' f; do FILES+=("$f"); done < <(git ls-files -z '*.sh')
fi
SCAN=()
for f in ${FILES[@]+"${FILES[@]}"}; do
  case "$f" in test/fixtures/guards/*) continue ;; esac
  SCAN+=("$f")
done
if [ "${#SCAN[@]}" -eq 0 ]; then
  echo "✓ bash 3.2 parse: no shell scripts under $ROOT"
  exit 0
fi

is_bash3() {
  [ -x "$1" ] && [ "$("$1" -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null)" = "3" ]
}

unavailable() {
  if [ "$REQUIRE" = "1" ]; then
    echo "✗ bash 3.2 parse: $1, and GBRAIN_BASH32_REQUIRE=1 forbids skipping" >&2
    exit 2
  fi
  echo "- bash 3.2 parse: skipped ($1; install Docker or set GBRAIN_BASH32 to a bash 3.2 binary)"
  exit 0
}

PARSER="${GBRAIN_BASH32:-}"
if [ -z "$PARSER" ] && is_bash3 /bin/bash; then PARSER=/bin/bash; fi
if [ -n "$PARSER" ] && [ "$PARSER" != "docker" ]; then
  if ! is_bash3 "$PARSER"; then
    echo "✗ bash 3.2 parse: GBRAIN_BASH32=$PARSER is not an executable bash 3.x" >&2
    exit 2
  fi
  label="$PARSER ($("$PARSER" -c 'echo "$BASH_VERSION"'))"
  out=""
  status=0
  for f in "${SCAN[@]}"; do
    err=$("$PARSER" -n "$f" 2>&1) || { status=1; out="$out$err
"; }
  done
else
  command -v "$DOCKER" >/dev/null 2>&1 || unavailable "no bash 3.x at /bin/bash and no docker CLI"
  "$DOCKER" info >/dev/null 2>&1 || unavailable "the Docker daemon is not reachable"
  label="$IMAGE"
  out=$("$DOCKER" run --rm -v "$ROOT":/w:ro -w /w "$IMAGE" bash -c \
    'rc=0; for f; do bash -n "$f" 2>&1 || rc=1; done; exit $rc' _ "${SCAN[@]}" 2>&1)
  status=$?
  if [ "$status" -gt 1 ]; then
    printf '%s\n' "$out" >&2
    unavailable "docker run $IMAGE failed (exit $status)"
  fi
fi

if [ "$status" -eq 0 ]; then
  echo "✓ bash 3.2 parse: ${#SCAN[@]} script(s) parse under $label"
  exit 0
fi

errors=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  errors=$((errors + 1))
  case "$line" in
    *": line "[0-9]*": "*)
      file="${line%%: line *}"
      rest="${line#*: line }"
      echo "FAIL: $file:${rest%%:*} does not parse under bash 3.2: ${rest#*: }" >&2
      ;;
    *) echo "FAIL: $line" >&2 ;;
  esac
done <<< "$out"
echo "Why:  macOS /bin/bash is GNU bash 3.2; a script it cannot parse fails on every Mac (bun run verify included)." >&2
echo "Fix:  read heredoc text with IFS= read -r -d '' VAR <<'EOF' || true instead of VAR=\$(cat <<'EOF' ... EOF), or rewrite the shape bash 3.2 rejects." >&2
echo "See:  docs/TESTING.md#bash-32-parse-guard" >&2
echo "" >&2
echo "✗ bash 3.2 parse: $errors error line(s) under $label" >&2
exit 1
