#!/bin/bash
# keys-unique.sh <worktree>: every top-level u8 key tag in rust/crates/gbrain-store/src/keys.rs is unique,
# and EMBEDDING_HOLD / REASON_TOMBSTONE do not take 'h' / 'y' (registry: /var/tmp/trunk/RUNBOOK.md).
f="${1:?worktree}/rust/crates/gbrain-store/src/keys.rs"
[ -f "$f" ] || { echo "keys-unique: no $f"; exit 2; }
tags=$(grep -oE "^pub const [A-Z0-9_]+: u8 = b'.'" "$f")
dups=$(echo "$tags" | sed -E "s/.*b'(.)'/\1/" | sort | uniq -d)
rc=0
if [ -n "$dups" ]; then echo "keys-unique: FAIL duplicate tags: $dups"; echo "$tags" | grep -E "b'($(echo $dups | tr ' ' '|'))'"; rc=1; fi
for bad in "EMBEDDING_HOLD: u8 = b'h'" "REASON_TOMBSTONE: u8 = b'y'"; do
  grep -q "$bad" "$f" && { echo "keys-unique: FAIL registry violation: $bad"; rc=1; }
done
[ $rc -eq 0 ] && echo "keys-unique: PASS $(echo "$tags" | grep -c .) tags unique"
exit $rc
