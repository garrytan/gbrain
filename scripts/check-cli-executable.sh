#!/bin/bash
# CI guard: src/cli.ts must be tracked by git in executable mode (100755).
#
# Why: bun-link installs symlink to src/cli.ts directly. If the mode bit
# regresses to 100644, the very first `gbrain --version` invocation fails
# with `permission denied`. v0.28.5 (cluster C, #683) fixed the original
# regression; this guard prevents future drift.
#
# Wired into `bun run verify`. Fast, no external deps.
set -e

MODE=$(git ls-files --stage src/cli.ts | awk '{print $1}')
if [ "$MODE" != "100755" ]; then
  echo "FAIL: src/cli.ts is tracked at mode $MODE; expected 100755 (executable)."
  echo ""
  echo "Fix: chmod +x src/cli.ts && git add --chmod=+x src/cli.ts"
  echo ""
  echo "Background: bun-link installs symlink to this file directly. Mode 100644"
  echo "produces 'permission denied' on first invocation (issue #683)."
  exit 1
fi

echo "OK: src/cli.ts is git-tracked as executable (100755)"
