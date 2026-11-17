#!/usr/bin/env bash
# scripts/ci-dependency-audit.sh — run `bun audit` for the root and admin/
# lockfiles; fail only when the run is blocking (test.yml dependency-audit
# scope step; env BLOCKING=true|false, REASON). Otherwise a found advisory is
# a ::warning:: naming why this run does not block (GBRA-47 B11).
#
# A run that never got an answer is not an advisory: a registry or network
# error (bun's "error: POST <url> - 503", a refused connection, an attempt past
# its time limit) is retried with backoff inside AUDIT_DEADLINE_S, then reported
# as audit_registry_unavailable. Any other failure without bun's advisory report
# is audit_incomplete. Both block a blocking run, because nothing was checked.
#
# admin/osv-scanner.toml lists advisories ignored for admin/ only, each with an
# ignoreUntil date (OSV-Scanner reads the same file). Each id is passed to the
# admin bun audit as --ignore until its date; on and after that date the entry
# is audit_ignore_expired, which blocks a blocking run. AUDIT_IGNORE_FILE and
# AUDIT_TODAY (YYYY-MM-DD) override the file and the date for tests.
set -uo pipefail

deadline=$(( SECONDS + ${AUDIT_DEADLINE_S:-420} ))
read -r -a delays <<< "${AUDIT_RETRY_DELAYS:-15 45}"
found=0 unavailable="" incomplete="" expired=""

ignore_file=${AUDIT_IGNORE_FILE:-admin/osv-scanner.toml}
today=${AUDIT_TODAY:-$(date -u +%F)}
admin_ignores=()
if [ -f "$ignore_file" ]; then
  entries=$(awk '
    function flush() { if (inblock) { if (id == "") bad = 1; else print id, (until == "" ? "none" : until) } }
    /^[[:space:]]*(#|$)/ { next }
    /^[[:space:]]*\[\[IgnoredVulns\]\][[:space:]]*$/ { flush(); inblock = 1; id = ""; until = ""; next }
    /^[[:space:]]*\[/ { flush(); inblock = 0; next }
    inblock && /^[[:space:]]*id[[:space:]]*=/ { if (match($0, /"[^"]*"/)) id = substr($0, RSTART + 1, RLENGTH - 2); else bad = 1; next }
    inblock && /^[[:space:]]*ignoreUntil[[:space:]]*=/ { v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]*(#.*)?$/, "", v); until = v; next }
    inblock && /^[[:space:]]*[A-Za-z_]+[[:space:]]*=/ { next }
    { bad = 1 }
    END { flush(); if (bad) exit 1 }
  ' "$ignore_file") || { echo "::error::audit_ignore_unreadable: $ignore_file has a line or an entry this script cannot read (each [[IgnoredVulns]] needs id = \"<id>\" and ignoreUntil = YYYY-MM-DD)"; exit 1; }
  while read -r id until; do
    [ -n "$id" ] || continue
    if ! [[ "$until" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then expired+="${expired:+; }$id has no ignoreUntil date"
    elif [[ ! "$today" < "$until" ]]; then expired+="${expired:+; }$id expired on $until"
    else admin_ignores+=("--ignore=$id"); echo "bun audit in admin ignores $id until $until ($ignore_file)"; fi
  done <<< "$entries"
fi

audit() {
  local dir=$1 attempt=0 out rc remaining
  shift
  while :; do
    remaining=$(( deadline - SECONDS ))
    if [ "$remaining" -lt 10 ]; then unavailable+="${unavailable:+; }$dir: not attempted, AUDIT_DEADLINE_S spent on earlier attempts"; return 0; fi
    out=$(cd "$dir" && timeout "$(( remaining < ${AUDIT_ATTEMPT_TIMEOUT_S:-120} ? remaining : ${AUDIT_ATTEMPT_TIMEOUT_S:-120} ))" bun audit "$@" 2>&1); rc=$?
    printf '%s\n' "$out"
    [ "$rc" -eq 0 ] && return 0
    if grep -Eq '^[0-9]+ vulnerabilit(y|ies) \(' <<< "$out"; then found=1; return 0; fi
    local why
    if [ "$rc" -eq 124 ]; then why="no answer within the attempt's time limit"
    else why=$(grep -E '^error: ' <<< "$out" | tail -1)
      if ! grep -Eiq '^error: (GET|POST) https?://[^ ]+ - [0-9]{3}$|connection|ECONN|timed? ?out|network|DNS|resolve host' <<< "$why"; then
        incomplete+="${incomplete:+; }$dir: ${why:-bun audit exited $rc without an advisory report}"; return 0
      fi
    fi
    local delay=${delays[$attempt]:-}
    if [ -z "$delay" ] || [ $(( deadline - SECONDS - delay )) -lt 10 ]; then
      unavailable+="${unavailable:+; }$dir: $why (attempt $(( attempt + 1 )))"; return 0
    fi
    echo "bun audit in $dir got no answer ($why); retrying in ${delay}s"
    sleep "$delay"; attempt=$(( attempt + 1 ))
  done
}

audit .
audit admin "${admin_ignores[@]}"

blocking=true; [ "${BLOCKING:-true}" = false ] && blocking=false
problems=0
if [ -n "$unavailable" ]; then
  problems=1
  msg="audit_registry_unavailable: bun audit got no answer from the registry's advisory endpoint, so no advisory was checked ($unavailable). Why: a registry or network outage is not an advisory and is never reported as one. Fix: rerun the dependency-audit job once the registry answers (https://status.npmjs.org)."
  if $blocking; then echo "::error::$msg (blocking: ${REASON:-unknown scope})"; else echo "::warning::$msg (advisory-only: ${REASON:-})"; fi
fi
if [ -n "$incomplete" ]; then
  problems=1
  msg="audit_incomplete: bun audit failed without an advisory report ($incomplete). Why: a failed audit checked nothing, which is not the same as finding advisories. Fix: run bun audit locally in that directory and fix what it reports (lockfile or install state)."
  if $blocking; then echo "::error::$msg (blocking: ${REASON:-unknown scope})"; else echo "::warning::$msg (advisory-only: ${REASON:-})"; fi
fi
if [ -n "$expired" ]; then
  problems=1
  msg="audit_ignore_expired: an ignored advisory in $ignore_file is past its date or has none ($expired), so it is checked again. Why: an ignore is approved only until its date. Fix: bump or replace the package, or get a new approval and date and update the entry."
  if $blocking; then echo "::error::$msg (blocking: ${REASON:-unknown scope})"; else echo "::warning::$msg (advisory-only: ${REASON:-})"; fi
fi
if [ "$found" -eq 1 ]; then
  problems=1
  if $blocking; then
    echo "::error::bun audit found advisories (blocking: ${REASON:-unknown scope}). Why: this run changes dependencies or protects master, so a known-vulnerable package must not land. Fix: bump the package (bun update <pkg>) or add an overrides entry, then push."
  else
    echo "::warning::bun audit found advisories; advisory-only on this pull request (${REASON:-}). Why: an upstream advisory must not turn every open PR red; pushes and the nightly run block on it. Fix: none needed here; to block on it, add the dependency-audit label and push."
  fi
fi
if [ "$problems" -eq 0 ]; then
  echo "bun audit: no advisories."
  exit 0
fi
$blocking && exit 1
exit 0
