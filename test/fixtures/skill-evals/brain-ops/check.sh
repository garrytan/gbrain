#!/bin/sh
# Asserts a brain-ops eval task's end state: sh check.sh <task-id>
. "$(dirname "$0")/../_lib/eval.sh"
EXTERNAL='curl |wget |"name":"(WebSearch|WebFetch|web_search)"'
first_line() { calls | grep -n -E "$1" | head -1 | cut -d: -f1; }
case "$1" in
  brain-first)
    ran 'gbrain ' || fail "no gbrain call"
    g=$(first_line 'gbrain '); e=$(first_line "$EXTERNAL")
    [ -z "$e" ] || [ "$g" -lt "$e" ] || fail "external lookup before the brain" ;;
  lisbon-saved)
    { gbh recall people/bob-example 2>/dev/null; brain_dump; } | grep -q -i lisbon || fail "Lisbon not in the brain" ;;
  unchanged)
    same_as_seed brain_dump || fail "the brain changed" ;;
  no-dave)
    ! brain_has 'dave' || fail "dave-example was written to the brain"
    ! gbh recall --grep CTO 2>/dev/null | grep -q -i dave || fail "a fact about dave-example was saved" ;;
  q4-backlinked)
    brain_has 'Q4 launch' || fail "the meeting was not saved"
    for s in people/alice-example people/bob-example companies/acme-example; do
      { gbh backlinks "$s" 2>/dev/null; gbh get "$s" 2>/dev/null; gbh timeline "$s" 2>/dev/null; } | grep -q -i -E 'q4|2026-10-20' || fail "$s has no link or timeline entry for the meeting"
    done ;;
  alice-no-duplicate)
    n=$(gbh list --limit 1000 | cut -f1 | grep -c -i alic || true)
    [ "$n" = 1 ] || fail "$n alice pages"
    { gbh recall people/alice-example 2>/dev/null; gbh get people/alice-example; } | grep -q -i 'design partner' || fail "design partner not saved on people/alice-example" ;;
  ran-entity)
    ran 'gbrain entity ' || fail "gbrain entity not used" ;;
  sailing-withdrawn)
    ! gbh recall people/bob-example 2>/dev/null | grep -q -i sailing || fail "the sailing fact is still active" ;;
  carol-kinds)
    out=$(gbh recall people/carol-example 2>/dev/null; gbh get people/carol-example 2>/dev/null)
    echo "$out" | grep -q -i -E 'preference' || fail "no preference fact"
    echo "$out" | grep -q -i -E 'commitment' || fail "no commitment fact" ;;
  *) echo "unknown check $1" >&2; exit 2 ;;
esac
