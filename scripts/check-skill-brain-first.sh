#!/usr/bin/env bash
# CI guard for the v0.36.x skill_brain_first doctor check.
#
# Runs `gbrain doctor --json` against this repo's own skills/ and parses
# the JSON to assert `checks[name=skill_brain_first].status !== "warn"`.
# Doctor's exit code only flags `fail`, not `warn`, so explicit JSON-
# parsing is required to gate `bun run verify` on this warning-class check
# (F15 from /plan-eng-review).
#
# When this fires, the brain-first compliance check found new offenders
# in this repo's skills. Either:
#   - add `brain_first: exempt` to the flagged skill's frontmatter (if it
#     legitimately doesn't need brain-first), or
#   - add a canonical `> **Convention:** see [conventions/brain-first.md]`
#     callout near the top of the skill body.
#
# Usage: scripts/check-skill-brain-first.sh
# Exit:  0 on ok; 1 on warn or unexpected.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Run doctor with this repo's own skills as the explicit target.
#
# --fast is REQUIRED here. Without it, doctor calls connectEngine() which
# exits 1 when no ~/.gbrain/config.json exists (the CI runner's case — no
# brain init), producing zero stdout and tripping the parser's
# `parse_error` fallback. --fast routes through runDoctor(null, ...) which
# runs filesystem-only checks (resolver_health, skill_conformance,
# skill_brain_first) and emits the standard JSON envelope. The
# skill_brain_first check is filesystem-only by design, so --fast is the
# correct knob, not a workaround.
#
# Capturing JSON output; redirect stderr to keep progress noise out of the
# parse.
TMPOUT="$(mktemp -t gbrain-doctor-XXXXXXXX)"
# shellcheck disable=SC2064
trap "rm -f \"$TMPOUT\"" EXIT

GBRAIN_SKILLS_DIR="$ROOT/skills" bun run src/cli.ts doctor --fast --json >"$TMPOUT" 2>/dev/null || true

# Extract the skill_brain_first check status. Use python3 (already a
# repo-wide dependency via image-decoders + admin tooling) so we don't
# add jq to the verify chain.
STATUS=$(python3 -c "
import json, sys
with open('$TMPOUT') as fp:
    for line in fp:
        line = line.strip()
        if not (line.startswith('{') and line.endswith('}')):
            continue
        try:
            report = json.loads(line)
        except Exception:
            continue
        for c in report.get('checks', []):
            if c.get('name') == 'skill_brain_first':
                print(c.get('status', 'missing'))
                sys.exit(0)
        print('missing')
        sys.exit(0)
print('parse_error')
" 2>/dev/null || echo "parse_error")

case "$STATUS" in
  ok)
    echo "OK: skill_brain_first check passes against this repo's skills/"
    exit 0
    ;;
  warn)
    echo
    echo "ERROR: skill_brain_first check found violations in this repo's skills/."
    echo
    echo "Re-run for details:"
    echo "  GBRAIN_SKILLS_DIR=\"\$(pwd)/skills\" bun run src/cli.ts doctor"
    echo
    echo "Fix options per skill:"
    echo "  1. Add 'brain_first: exempt' to frontmatter (declarative opt-out)"
    echo "  2. Add a > **Convention:** see [conventions/brain-first.md] callout"
    echo "  3. Run 'gbrain doctor --fix' to auto-add the canonical callout"
    exit 1
    ;;
  fail)
    echo "ERROR: skill_brain_first check returned status=fail (unexpected)."
    exit 1
    ;;
  missing)
    echo "ERROR: skill_brain_first check not present in doctor output."
    echo "       This guard expected the check to run. Investigate doctor.ts wiring."
    exit 1
    ;;
  *)
    echo "ERROR: skill_brain_first guard could not parse doctor --json output."
    echo "       Status: $STATUS"
    cat "$TMPOUT" | head -20
    exit 1
    ;;
esac
