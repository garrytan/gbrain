#!/usr/bin/env bash
# Known-bad: bash 5 parses this, bash 3.2 does not. The heredoc sits inside
# $(...) and its body carries an odd apostrophe, the #5810 shape.
TABLE=$(cat <<'EOF'
row-one	it's the current instruction
EOF
)
printf '%s\n' "$TABLE"
