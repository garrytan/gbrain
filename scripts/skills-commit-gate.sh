#!/usr/bin/env bash
# skills-commit-gate — the per-commit gate for any commit touching skills/.
#
# Runs the four checks that actually fail skills-pack changes, in seconds:
#   1. conformance + resolver round-trip + plugin-manifest tests (the
#      membership/closure + plugin.version assertions run in the gate, not just CI)
#   2. check-resolvable --strict (MECE overlap, DRY delegation, filing audit,
#      routing-eval fixtures)
#   3. skills.lock.json regen + freshness
#   4. check-skill-refs (dangling refs, donor remnants, CLI refs warn-only)
#
# Optional: pass changed .md file paths as arguments to also run the harvest
# privacy linter over them (the merge-lane lint — harvest can't lint merges).
#
# Usage: bash scripts/skills-commit-gate.sh [changed-file.md ...]
set -uo pipefail

FAIL=0
step() {
  echo "── $1" >&2
  shift
  if ! "$@"; then
    echo "❌ gate step failed: $1" >&2
    FAIL=1
  fi
}

step "conformance + resolver + plugin-manifest tests" bun test --timeout=60000 test/skills-conformance.test.ts test/resolver.test.ts test/openclaw-plugin-manifest.test.ts
step "check-resolvable --strict" bun src/cli.ts check-resolvable --strict --skills-dir skills/
step "skills.lock regen" bun run scripts/generate-skills-manifest.ts
# The regen may have rewritten the lock on disk. Two stale shapes, both fail:
#   staged-but-stale  — the path is staged but the staged BLOB differs from the
#                       regenerated file (a staged name alone proves nothing —
#                       the commit would still ship the old content)
#   unstaged-and-dirty — the regenerated file differs from HEAD and nothing is
#                       staged, so the commit would ship a stale lock
if git diff --cached --name-only -- skills/skills.lock.json | grep -q '^skills/skills.lock.json$'; then
  if ! git show :skills/skills.lock.json 2>/dev/null | cmp -s - skills/skills.lock.json; then
    echo "❌ staged lock is stale — re-stage skills/skills.lock.json (git add skills/skills.lock.json)" >&2
    FAIL=1
  fi
elif [ -n "$(git diff --name-only -- skills/skills.lock.json)" ]; then
  echo "❌ skills.lock.json regenerated — stage it (git add skills/skills.lock.json)" >&2
  FAIL=1
fi
step "skills.lock freshness" bash scripts/check-skills-manifest-fresh.sh
step "skill refs" bun scripts/check-skill-refs.mjs

if [ "$#" -gt 0 ]; then
  # Single-quoted on purpose: nothing here is for bash to interpolate.
  step "privacy lint (merge lane)" bun -e '
    import { existsSync } from "node:fs";
    import { runPrivacyLint } from "./src/core/skillpack/harvest-lint.ts";
    const files = process.argv.slice(1);
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length) {
      console.error("privacy lint: " + missing.length + " argv path(s) do not exist:");
      for (const f of missing) console.error("MISSING " + f);
      process.exit(1);
    }
    try {
      runPrivacyLint(files);
      console.log("privacy lint: OK (" + files.length + " files)");
    } catch (e) {
      console.error(String(e?.message ?? e));
      for (const h of e?.hits ?? []) console.error("LINT " + h);
      process.exit(1);
    }
  ' "$@"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "❌ skills-commit-gate: FAILED" >&2
  exit 1
fi
echo "✅ skills-commit-gate: all green"
