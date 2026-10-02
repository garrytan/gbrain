#!/usr/bin/env bash
# Known-good: the same table read with read -d '', which bash 3.2 parses.
IFS= read -r -d '' TABLE <<'EOF' || true
row-one	it's the current instruction
EOF
printf '%s' "$TABLE"
