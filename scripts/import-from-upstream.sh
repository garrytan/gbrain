#!/usr/bin/env bash
# Deterministic import of upstream voice-agent source into gbrain's
# recipes/agent-voice/code/ reference bundle.
#
# Usage:
#   AGENT_VOICE_SUBSTITUTIONS="PRIVATE_AGENT_NAME_LC=...|PRIVATE_AGENT_NAME_TC=...|OPERATOR_FIRST_NAME=...|FAMILY_MEMBER_1=...|..." \
#   AGENT_VOICE_PII_BLOCKLIST="..." \
#     scripts/import-from-upstream.sh \
#       --from /path/to/upstream/services/voice-agent \
#       --to recipes/agent-voice/code \
#       [--dry-run]
#
# Behavior:
#   1. Stage upstream files into a tmpdir (preserves permissions, skips .git).
#   2. Apply file renames declared by __RENAME__ lines in scripts/upstream-scrub-table.txt.
#   3. Apply sed substitutions from the table (regular lines), with
#      envsubst-expanded placeholders ($AGENT_VOICE_SUBSTITUTIONS).
#   4. Run scripts/check-no-pii-in-agent-voice.sh against the staged tmpdir.
#   5. If the PII guard passes, rsync staged → --to destination.
#      If it fails, leave the tmpdir for inspection and exit non-zero.
#
# Determinism: same upstream input + same env vars + same scrub table = same
# output. Reproducible refresh from upstream is a single command.

set -euo pipefail

FROM=""
TO=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$FROM" ] || [ -z "$TO" ]; then
  echo "ERROR: both --from and --to are required." >&2
  echo "       Run with --help for usage." >&2
  exit 2
fi

if [ ! -d "$FROM" ]; then
  echo "ERROR: --from is not a directory: $FROM" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TABLE="$ROOT/scripts/upstream-scrub-table.txt"
GUARD="$ROOT/scripts/check-no-pii-in-agent-voice.sh"

if [ ! -f "$TABLE" ]; then
  echo "ERROR: substitution table missing: $TABLE" >&2
  exit 2
fi
if [ ! -x "$GUARD" ]; then
  echo "ERROR: PII guard missing or not executable: $GUARD" >&2
  echo "       Run: chmod +x $GUARD" >&2
  exit 2
fi

# Stage to tmpdir.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/agent-voice-import.XXXXXXXX")
trap '[ "$DRY_RUN" -eq 1 ] || rm -rf "$STAGE"' EXIT
echo "[import] staging upstream → $STAGE"
# rsync preserves permissions, mtime; excludes upstream .git and node_modules.
rsync -a --exclude='.git/' --exclude='node_modules/' --exclude='.DS_Store' "$FROM/" "$STAGE/"

# Expand AGENT_VOICE_SUBSTITUTIONS into a process-env that envsubst can see.
# The var is a pipe-separated key=value list; split into individual exports.
if [ -n "${AGENT_VOICE_SUBSTITUTIONS:-}" ]; then
  IFS='|' read -ra PAIRS <<< "$AGENT_VOICE_SUBSTITUTIONS"
  for pair in "${PAIRS[@]}"; do
    key="${pair%%=*}"
    val="${pair#*=}"
    # Only allow [A-Z_][A-Z0-9_]* as keys (env-var safe).
    if [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
      export "$key"="$val"
    else
      echo "WARN: skipping invalid substitution key: $key" >&2
    fi
  done
else
  echo "WARN: AGENT_VOICE_SUBSTITUTIONS is unset; placeholder-driven rows will not expand." >&2
  echo "      Hardcoded path rules still apply; private-name scrubs require the env var." >&2
fi

# Pass 1: file renames.
echo "[import] applying __RENAME__ rules"
RENAME_COUNT=0
while IFS=$'\t' read -r tag from_path to_path _comment; do
  [ "$tag" = "__RENAME__" ] || continue
  from_abs="$STAGE/$from_path"
  to_abs="$STAGE/$to_path"
  if [ -e "$from_abs" ]; then
    mkdir -p "$(dirname "$to_abs")"
    mv "$from_abs" "$to_abs"
    RENAME_COUNT=$((RENAME_COUNT+1))
    echo "  renamed: $from_path → $to_path"
  fi
done < <(grep -v '^#' "$TABLE" | grep -v '^[[:space:]]*$')
echo "[import] $RENAME_COUNT renames applied"

# Pass 2: sed substitutions (regular non-rename lines).
# Build a sed script file from the table, expanded via envsubst.
SED_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/agent-voice-sed.XXXXXXXX")
trap 'rm -f "$SED_SCRIPT"' EXIT

# Expand env vars in the substitution patterns. Use envsubst with a allow-list
# so we don't accidentally substitute $HOME or other unrelated vars.
ENVSUBST_VARS='${PRIVATE_AGENT_NAME_LC} ${PRIVATE_AGENT_NAME_TC} ${OPERATOR_FIRST_NAME} ${OPERATOR_FIRST_NAME_LC} ${FAMILY_MEMBER_1} ${FAMILY_MEMBER_2} ${FAMILY_MEMBER_3} ${FAMILY_MEMBER_4} ${FAMILY_MEMBER_5} ${THERAPIST_1} ${THERAPIST_2}'

# Build sed -E expressions. Format per line:
#   s|<from>|<to>|g
# Use | as delimiter so / in paths doesn't conflict.
while IFS=$'\t' read -r from_pat to_lit _comment; do
  # Skip __RENAME__ rows and comments and blanks.
  [ "$from_pat" = "__RENAME__" ] && continue
  [ -z "$from_pat" ] && continue
  [[ "$from_pat" == \#* ]] && continue
  # Expand env-var placeholders inside from_pat.
  expanded_from=$(echo "$from_pat" | envsubst "$ENVSUBST_VARS")
  # If the pattern still contains a literal ${...} placeholder, the env var
  # was unset; skip the row with a warning (and don't generate a useless sed).
  if [[ "$expanded_from" == *'${'* ]]; then
    echo "WARN: skipping unexpanded substitution row: $from_pat" >&2
    continue
  fi
  # Escape any '|' in the from/to before using as sed delimiter.
  from_esc="${expanded_from//|/\\|}"
  to_esc="${to_lit//|/\\|}"
  echo "s|${from_esc}|${to_esc}|g" >> "$SED_SCRIPT"
done < <(cat "$TABLE")

SED_RULES=$(wc -l < "$SED_SCRIPT" | tr -d ' ')
echo "[import] applying $SED_RULES sed substitutions across staged files"

# Apply to all text files under stage. Skip binaries.
find "$STAGE" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 | \
  while IFS= read -r -d '' file; do
    # Use `file` to detect text. If text, sed in place (BSD sed needs '' arg).
    if file "$file" | grep -q 'text\|JSON\|XML\|HTML\|empty\|ASCII\|Unicode'; then
      # BSD sed: -i '' ; GNU sed: -i. Use a portable form via perl-style sed:
      # Use a wrapper that handles both.
      if sed --version >/dev/null 2>&1; then
        # GNU sed
        sed -E -i -f "$SED_SCRIPT" "$file"
      else
        # BSD sed
        sed -E -i '' -f "$SED_SCRIPT" "$file"
      fi
    fi
  done

# Pass 3: PII guard against the staged tmpdir.
echo "[import] running PII guard against staged output"
# Run the guard with SCAN_PATHS overridden to point at the stage. Since the
# guard hardcodes scan paths relative to repo root, we run it from inside the
# stage with a wrapped invocation: feed the regex set through grep manually.
# Simpler: copy the stage to a sentinel location under recipes/agent-voice/
# briefly, run the guard, then revert. Cleaner: extract the regex into a
# subordinate script. For v0, just call the guard against the destination
# AFTER the rsync, and revert if it fails.

# Pass 4: rsync staged → destination (or print diff if --dry-run).
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[import] DRY RUN — would rsync $STAGE → $TO"
  echo "[import] staged content kept at $STAGE for inspection"
  exit 0
fi

# Capture pre-state for revert-on-guard-fail.
PRE_BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/agent-voice-prebackup.XXXXXXXX")
if [ -d "$TO" ]; then
  rsync -a "$TO/" "$PRE_BACKUP/"
else
  mkdir -p "$TO"
fi

echo "[import] rsyncing $STAGE → $TO"
rsync -a --delete "$STAGE/" "$TO/"

echo "[import] running PII guard against destination"
if "$GUARD"; then
  echo "[import] PII guard PASSED"
  rm -rf "$PRE_BACKUP"
  echo "[import] DONE. Import successful."
else
  echo "[import] PII guard FAILED — reverting destination" >&2
  rsync -a --delete "$PRE_BACKUP/" "$TO/"
  rm -rf "$PRE_BACKUP"
  echo "[import] reverted. Inspect staged output at: $STAGE" >&2
  echo "[import] (the stage is preserved because the guard failed)" >&2
  trap - EXIT
  exit 1
fi
