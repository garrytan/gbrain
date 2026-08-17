#!/usr/bin/env bash
# scripts/check-opencode-pin.sh — opencode pin consistency guard.
#
# OPENCODE-CLI-PIN.md is the single observed-behavior source for the opencode
# integration; its pins fan out to the heavy-tests opencode-door job env, the
# OpencodeRunner argv, and the door e2e assertions. The prose rule is "update
# together" — this guard turns the workflow half of that rule into CI:
#
#   1. docs/mcp/OPENCODE-CLI-PIN.md carries a machine-stable stamp block
#      (`<!-- opencode-pin: key=value -->`, one per line) including
#      distribution_kind (npm | installer).
#   2. The opencode-door job env in .github/workflows/heavy-tests.yml must carry
#      EXACTLY the pin set for the chosen distribution_kind:
#        npm:       OPENCODE_VERSION==opencode_version, OPENCODE_NPM_PACKAGE==npm_package,
#                   OPENCODE_NPM_INTEGRITY==npm_integrity; no OPENCODE_INSTALL_SHA256.
#        installer: OPENCODE_VERSION==opencode_version,
#                   OPENCODE_INSTALL_SHA256==installer_sha256; no OPENCODE_NPM_INTEGRITY.
#      (The pin DOC may document both — the fallback path stays written down;
#      exclusivity is about which pins the WORKFLOW actually enforces.)
#
# Greps are anchored to the opencode-door job block so a future canary matrix leg
# (or a second door job) cannot satisfy the check by accident.
#
# SKIP-GRACEFUL: missing pin doc, missing workflow, or no opencode-door job yet →
# SKIP (exit 0), matching scripts/check-bootstrap-tag.sh. Test override:
# GBRAIN_OPENCODE_PIN_GUARD_ROOT points file resolution at a fixture tree.
# BSD/GNU portable (no \t escapes, no GNU-only flags).

set -euo pipefail

ROOT="${GBRAIN_OPENCODE_PIN_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PIN_FILE="$ROOT/docs/mcp/OPENCODE-CLI-PIN.md"
WORKFLOW="$ROOT/.github/workflows/heavy-tests.yml"

if [ ! -f "$WORKFLOW" ]; then
  echo "check-opencode-pin: SKIP (no $WORKFLOW)"
  exit 0
fi
if ! grep -q '^  opencode-door:' "$WORKFLOW"; then
  echo "check-opencode-pin: SKIP (no opencode-door job in heavy-tests.yml yet)"
  exit 0
fi
# Once the opencode-door job EXISTS, a missing pin doc is a FAILURE, not a skip —
# deleting/renaming the doc must not silently disable the supply-chain gate.
if [ ! -f "$PIN_FILE" ]; then
  echo "check-opencode-pin: FAIL — opencode-door job exists but $PIN_FILE is missing (the pin doc is the gate's source of truth)" >&2
  exit 1
fi

fail() {
  echo "check-opencode-pin: FAIL — $1" >&2
  exit 1
}

# --- 1. Parse the stamp block ------------------------------------------------
stamp() {
  # First occurrence wins; a missing stamp yields the empty string (callers
  # decide whether that is a failure) — the `|| true` keeps set -e/pipefail
  # from treating grep's no-match exit as a script error.
  { grep -E "^<!-- opencode-pin: $1=" "$PIN_FILE" || true; } | head -1 \
    | sed -e 's/^<!-- opencode-pin: [a-z0-9_]*=//' -e 's/ -->$//'
}

# Duplicate stamps are drift bait (two values, which one is real?).
dupes=$({ grep -E '^<!-- opencode-pin: ' "$PIN_FILE" || true; } | sed -e 's/^<!-- opencode-pin: //' -e 's/=.*$//' | sort | uniq -d)
[ -n "$dupes" ] && fail "duplicate opencode-pin stamp(s) in OPENCODE-CLI-PIN.md: $dupes"

DIST_KIND=$(stamp distribution_kind)
OPENCODE_VERSION_PIN=$(stamp opencode_version)
[ -n "$DIST_KIND" ] || fail "OPENCODE-CLI-PIN.md is missing the distribution_kind stamp"
[ -n "$OPENCODE_VERSION_PIN" ] || fail "OPENCODE-CLI-PIN.md is missing the opencode_version stamp"
case "$DIST_KIND" in
  npm|installer) ;;
  *) fail "distribution_kind stamp must be npm or installer; got '$DIST_KIND'" ;;
esac

# --- 2. Extract the opencode-door job block --------------------------------------
# Jobs sit at 2-space indent; the block ends at the next 2-space-indented key.
job_block=$(awk '
  /^  opencode-door:/ { f = 1; print; next }
  f && /^  [A-Za-z0-9_-]+:/ { exit }
  f { print }
' "$WORKFLOW")
[ -n "$job_block" ] || fail "could not extract the opencode-door job block"

wf_env() {
  # Strip either quote style: a YAML-formatter pass flipping double to single
  # quotes must not read as pin drift.
  { printf '%s\n' "$job_block" | grep -E "^      $1:" || true; } | head -1 \
    | sed -e "s/^      $1:[[:space:]]*//" -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

WF_VERSION=$(wf_env OPENCODE_VERSION)
WF_NPM_PACKAGE=$(wf_env OPENCODE_NPM_PACKAGE)
WF_NPM_INTEGRITY=$(wf_env OPENCODE_NPM_INTEGRITY)
WF_INSTALL_SHA=$(wf_env OPENCODE_INSTALL_SHA256)

[ -n "$WF_VERSION" ] || fail "opencode-door job env is missing OPENCODE_VERSION"
[ "$WF_VERSION" = "$OPENCODE_VERSION_PIN" ] || fail "OPENCODE_VERSION drift — workflow '$WF_VERSION' vs pin-doc stamp '$OPENCODE_VERSION_PIN' (update together; see the pin doc's re-observation checklist)"

# EVERY OPENCODE_VERSION: env line in the WHOLE workflow (the real-agent-e2e
# door job carries a second copy) must equal the stamp — bumping the door job
# alone must never pass green. Env keys sit at line start after indentation,
# so comments mentioning the name never match.
all_wf_versions=$({ grep -E '^[[:space:]]*OPENCODE_VERSION:' "$WORKFLOW" || true; } \
  | sed -e 's/^[[:space:]]*OPENCODE_VERSION:[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")
for v in $all_wf_versions; do
  [ "$v" = "$OPENCODE_VERSION_PIN" ] || fail "an OPENCODE_VERSION occurrence elsewhere in heavy-tests.yml ('$v') disagrees with the pin-doc stamp '$OPENCODE_VERSION_PIN' — every copy in the workflow moves with the stamp"
done

if [ "$DIST_KIND" = "npm" ]; then
  NPM_PACKAGE_PIN=$(stamp npm_package)
  NPM_INTEGRITY_PIN=$(stamp npm_integrity)
  [ -n "$NPM_PACKAGE_PIN" ] || fail "distribution_kind=npm but OPENCODE-CLI-PIN.md is missing the npm_package stamp"
  [ -n "$NPM_INTEGRITY_PIN" ] || fail "distribution_kind=npm but OPENCODE-CLI-PIN.md is missing the npm_integrity stamp"
  [ -n "$WF_NPM_PACKAGE" ] || fail "distribution_kind=npm but the opencode-door job env is missing OPENCODE_NPM_PACKAGE"
  [ -n "$WF_NPM_INTEGRITY" ] || fail "distribution_kind=npm but the opencode-door job env is missing OPENCODE_NPM_INTEGRITY"
  [ "$WF_NPM_PACKAGE" = "$NPM_PACKAGE_PIN" ] || fail "OPENCODE_NPM_PACKAGE drift — workflow '$WF_NPM_PACKAGE' vs stamp '$NPM_PACKAGE_PIN'"
  [ "$WF_NPM_INTEGRITY" = "$NPM_INTEGRITY_PIN" ] || fail "OPENCODE_NPM_INTEGRITY drift — workflow vs stamp mismatch"
  # npm_version is a documented near-duplicate of opencode_version — assert they
  # agree so bumping one alone can never pass green.
  NPM_VERSION_PIN=$(stamp npm_version)
  if [ -n "$NPM_VERSION_PIN" ] && [ "$NPM_VERSION_PIN" != "$OPENCODE_VERSION_PIN" ]; then
    fail "npm_version stamp ($NPM_VERSION_PIN) disagrees with opencode_version stamp ($OPENCODE_VERSION_PIN) — update together"
  fi
  # Platform-payload integrity stamps (the door job byte-pins the linux
  # sub-packages too): when the pin doc carries them, the job env must match.
  X64_PIN=$(stamp npm_linux_x64_integrity)
  if [ -n "$X64_PIN" ]; then
    WF_X64=$(wf_env OPENCODE_NPM_LINUX_X64_INTEGRITY)
    [ -n "$WF_X64" ] || fail "pin doc stamps npm_linux_x64_integrity but the opencode-door job env is missing OPENCODE_NPM_LINUX_X64_INTEGRITY"
    [ "$WF_X64" = "$X64_PIN" ] || fail "OPENCODE_NPM_LINUX_X64_INTEGRITY drift — workflow vs stamp mismatch"
  fi
  ARM64_PIN=$(stamp npm_linux_arm64_integrity)
  if [ -n "$ARM64_PIN" ]; then
    WF_ARM64=$(wf_env OPENCODE_NPM_LINUX_ARM64_INTEGRITY)
    [ -n "$WF_ARM64" ] || fail "pin doc stamps npm_linux_arm64_integrity but the opencode-door job env is missing OPENCODE_NPM_LINUX_ARM64_INTEGRITY"
    [ "$WF_ARM64" = "$ARM64_PIN" ] || fail "OPENCODE_NPM_LINUX_ARM64_INTEGRITY drift — workflow vs stamp mismatch"
  fi
  [ -z "$WF_INSTALL_SHA" ] || fail "distribution_kind=npm but the opencode-door job also pins OPENCODE_INSTALL_SHA256 — one provisioning mode only (mode exclusivity)"
else
  INSTALL_SHA_PIN=$(stamp installer_sha256)
  [ -n "$INSTALL_SHA_PIN" ] || fail "distribution_kind=installer but OPENCODE-CLI-PIN.md is missing the installer_sha256 stamp"
  [ -n "$WF_INSTALL_SHA" ] || fail "distribution_kind=installer but the opencode-door job env is missing OPENCODE_INSTALL_SHA256"
  [ "$WF_INSTALL_SHA" = "$INSTALL_SHA_PIN" ] || fail "OPENCODE_INSTALL_SHA256 drift — workflow vs stamp mismatch"
  [ -z "$WF_NPM_INTEGRITY" ] || fail "distribution_kind=installer but the opencode-door job also pins OPENCODE_NPM_INTEGRITY — one provisioning mode only (mode exclusivity)"
fi

echo "check-opencode-pin: ok ($DIST_KIND mode, opencode $OPENCODE_VERSION_PIN)"
