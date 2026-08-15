#!/usr/bin/env bash
# scripts/check-grok-pin.sh — grok pin consistency guard.
#
# GROK-CLI-PIN.md is the single observed-behavior source for the grok
# integration; its pins fan out to the heavy-tests grok-door job env, the
# GrokRunner argv, and the door e2e assertions. The prose rule is "update
# together" — this guard turns the workflow half of that rule into CI:
#
#   1. docs/mcp/GROK-CLI-PIN.md carries a machine-stable stamp block
#      (`<!-- grok-pin: key=value -->`, one per line) including
#      distribution_kind (npm | installer).
#   2. The grok-door job env in .github/workflows/heavy-tests.yml must carry
#      EXACTLY the pin set for the chosen distribution_kind:
#        npm:       GROK_VERSION==grok_version, GROK_NPM_PACKAGE==npm_package,
#                   GROK_NPM_INTEGRITY==npm_integrity; no GROK_INSTALL_SHA256.
#        installer: GROK_VERSION==grok_version,
#                   GROK_INSTALL_SHA256==installer_sha256; no GROK_NPM_INTEGRITY.
#      (The pin DOC may document both — the fallback path stays written down;
#      exclusivity is about which pins the WORKFLOW actually enforces.)
#
# Greps are anchored to the grok-door job block so a future canary matrix leg
# (or a second door job) cannot satisfy the check by accident.
#
# SKIP-GRACEFUL: missing pin doc, missing workflow, or no grok-door job yet →
# SKIP (exit 0), matching scripts/check-bootstrap-tag.sh. Test override:
# GBRAIN_GROK_PIN_GUARD_ROOT points file resolution at a fixture tree.
# BSD/GNU portable (no \t escapes, no GNU-only flags).

set -euo pipefail

ROOT="${GBRAIN_GROK_PIN_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PIN_FILE="$ROOT/docs/mcp/GROK-CLI-PIN.md"
WORKFLOW="$ROOT/.github/workflows/heavy-tests.yml"

if [ ! -f "$WORKFLOW" ]; then
  echo "check-grok-pin: SKIP (no $WORKFLOW)"
  exit 0
fi
if ! grep -q '^  grok-door:' "$WORKFLOW"; then
  echo "check-grok-pin: SKIP (no grok-door job in heavy-tests.yml yet)"
  exit 0
fi
# Once the grok-door job EXISTS, a missing pin doc is a FAILURE, not a skip —
# deleting/renaming the doc must not silently disable the supply-chain gate.
if [ ! -f "$PIN_FILE" ]; then
  echo "check-grok-pin: FAIL — grok-door job exists but $PIN_FILE is missing (the pin doc is the gate's source of truth)" >&2
  exit 1
fi

fail() {
  echo "check-grok-pin: FAIL — $1" >&2
  exit 1
}

# --- 1. Parse the stamp block ------------------------------------------------
stamp() {
  # First occurrence wins; a missing stamp yields the empty string (callers
  # decide whether that is a failure) — the `|| true` keeps set -e/pipefail
  # from treating grep's no-match exit as a script error.
  { grep -E "^<!-- grok-pin: $1=" "$PIN_FILE" || true; } | head -1 \
    | sed -e 's/^<!-- grok-pin: [a-z0-9_]*=//' -e 's/ -->$//'
}

# Duplicate stamps are drift bait (two values, which one is real?).
dupes=$({ grep -E '^<!-- grok-pin: ' "$PIN_FILE" || true; } | sed -e 's/^<!-- grok-pin: //' -e 's/=.*$//' | sort | uniq -d)
[ -n "$dupes" ] && fail "duplicate grok-pin stamp(s) in GROK-CLI-PIN.md: $dupes"

DIST_KIND=$(stamp distribution_kind)
GROK_VERSION_PIN=$(stamp grok_version)
[ -n "$DIST_KIND" ] || fail "GROK-CLI-PIN.md is missing the distribution_kind stamp"
[ -n "$GROK_VERSION_PIN" ] || fail "GROK-CLI-PIN.md is missing the grok_version stamp"
case "$DIST_KIND" in
  npm|installer) ;;
  *) fail "distribution_kind stamp must be npm or installer; got '$DIST_KIND'" ;;
esac

# --- 2. Extract the grok-door job block --------------------------------------
# Jobs sit at 2-space indent; the block ends at the next 2-space-indented key.
job_block=$(awk '
  /^  grok-door:/ { f = 1; print; next }
  f && /^  [A-Za-z0-9_-]+:/ { exit }
  f { print }
' "$WORKFLOW")
[ -n "$job_block" ] || fail "could not extract the grok-door job block"

wf_env() {
  # Strip either quote style: a YAML-formatter pass flipping double to single
  # quotes must not read as pin drift.
  { printf '%s\n' "$job_block" | grep -E "^      $1:" || true; } | head -1 \
    | sed -e "s/^      $1:[[:space:]]*//" -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

WF_VERSION=$(wf_env GROK_VERSION)
WF_NPM_PACKAGE=$(wf_env GROK_NPM_PACKAGE)
WF_NPM_INTEGRITY=$(wf_env GROK_NPM_INTEGRITY)
WF_INSTALL_SHA=$(wf_env GROK_INSTALL_SHA256)

[ -n "$WF_VERSION" ] || fail "grok-door job env is missing GROK_VERSION"
[ "$WF_VERSION" = "$GROK_VERSION_PIN" ] || fail "GROK_VERSION drift — workflow '$WF_VERSION' vs pin-doc stamp '$GROK_VERSION_PIN' (update together; see the pin doc's re-observation checklist)"

if [ "$DIST_KIND" = "npm" ]; then
  NPM_PACKAGE_PIN=$(stamp npm_package)
  NPM_INTEGRITY_PIN=$(stamp npm_integrity)
  [ -n "$NPM_PACKAGE_PIN" ] || fail "distribution_kind=npm but GROK-CLI-PIN.md is missing the npm_package stamp"
  [ -n "$NPM_INTEGRITY_PIN" ] || fail "distribution_kind=npm but GROK-CLI-PIN.md is missing the npm_integrity stamp"
  [ -n "$WF_NPM_PACKAGE" ] || fail "distribution_kind=npm but the grok-door job env is missing GROK_NPM_PACKAGE"
  [ -n "$WF_NPM_INTEGRITY" ] || fail "distribution_kind=npm but the grok-door job env is missing GROK_NPM_INTEGRITY"
  [ "$WF_NPM_PACKAGE" = "$NPM_PACKAGE_PIN" ] || fail "GROK_NPM_PACKAGE drift — workflow '$WF_NPM_PACKAGE' vs stamp '$NPM_PACKAGE_PIN'"
  [ "$WF_NPM_INTEGRITY" = "$NPM_INTEGRITY_PIN" ] || fail "GROK_NPM_INTEGRITY drift — workflow vs stamp mismatch"
  # npm_version is a documented near-duplicate of grok_version — assert they
  # agree so bumping one alone can never pass green.
  NPM_VERSION_PIN=$(stamp npm_version)
  if [ -n "$NPM_VERSION_PIN" ] && [ "$NPM_VERSION_PIN" != "$GROK_VERSION_PIN" ]; then
    fail "npm_version stamp ($NPM_VERSION_PIN) disagrees with grok_version stamp ($GROK_VERSION_PIN) — update together"
  fi
  [ -z "$WF_INSTALL_SHA" ] || fail "distribution_kind=npm but the grok-door job also pins GROK_INSTALL_SHA256 — one provisioning mode only (mode exclusivity)"
else
  INSTALL_SHA_PIN=$(stamp installer_sha256)
  [ -n "$INSTALL_SHA_PIN" ] || fail "distribution_kind=installer but GROK-CLI-PIN.md is missing the installer_sha256 stamp"
  [ -n "$WF_INSTALL_SHA" ] || fail "distribution_kind=installer but the grok-door job env is missing GROK_INSTALL_SHA256"
  [ "$WF_INSTALL_SHA" = "$INSTALL_SHA_PIN" ] || fail "GROK_INSTALL_SHA256 drift — workflow vs stamp mismatch"
  [ -z "$WF_NPM_INTEGRITY" ] || fail "distribution_kind=installer but the grok-door job also pins GROK_NPM_INTEGRITY — one provisioning mode only (mode exclusivity)"
fi

echo "check-grok-pin: ok ($DIST_KIND mode, grok $GROK_VERSION_PIN)"
