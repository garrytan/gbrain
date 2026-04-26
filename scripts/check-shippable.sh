#!/usr/bin/env bash
# check-shippable.sh — Automated gate checks for the GBrain Shippable Standard.
#
# Walks a list of changed files, applies grep/AST patterns for each gate that
# can be reduced to a deterministic check. Emits JSONL findings to stdout.
# Judgment-based gates (PROOF, SCOPE, INTEGRATION-architectural) are left to
# the agent in skills/pre-ship-check/SKILL.md.
#
# Usage:
#   scripts/check-shippable.sh                    # diff vs master
#   scripts/check-shippable.sh --base <ref>       # diff vs explicit base
#   scripts/check-shippable.sh --all              # whole tree (audit mode)
#   scripts/check-shippable.sh --files f1 f2 ...  # explicit file list
#
# Output: one JSON object per line to stdout. Schema:
#   { gate, severity, file, line, evidence, fix_hint }
#
# Exit code: 0 if no blocking findings, 1 if any blocking finding emitted.
# Compatibility: macOS bash 3.2 + Linux bash 4+.

set -euo pipefail

# Force C locale so awk can process arbitrary byte sequences in source files
# (multibyte characters in comments, identifiers, etc.) without aborting.
export LC_ALL=C
export LANG=C

BASE="master"
MODE="diff"
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --all) MODE="all"; shift ;;
    --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do FILES+=("$1"); shift; done; MODE="explicit" ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- Build the file list (bash 3.2 compatible, no mapfile) ---
build_diff_list() {
  # Capture committed + staged + unstaged changes vs $BASE.
  # `git diff $BASE` (no triple-dot) includes the working tree, which is what
  # a pre-ship check actually wants — what's *going to* ship, not just what's
  # already committed. Then add untracked files explicitly.
  local committed_or_uncommitted untracked
  committed_or_uncommitted=$(git diff "$BASE" --name-only --diff-filter=AM 2>/dev/null | grep -E '\.(ts|js|md)$' || true)
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(ts|js|md)$' || true)
  while IFS= read -r line; do [[ -n "$line" ]] && FILES+=("$line"); done < <(
    printf '%s\n%s\n' "$committed_or_uncommitted" "$untracked" | sort -u | grep -v '^$' || true
  )
}

build_all_list() {
  while IFS= read -r line; do FILES+=("$line"); done < <(
    git ls-files | grep -E '\.(ts|js|md)$'
  )
}

case "$MODE" in
  diff) build_diff_list ;;
  all) build_all_list ;;
  explicit) : ;; # FILES already populated
esac

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo '{"status":"no_changes","blocking_count":0,"warning_count":0}'
  exit 0
fi

BLOCKING=0
WARNINGS=0

# --- Diff-awareness: only flag lines that were ADDED in this diff ---
# Pre-existing patterns in modified files are not the fork's debt to fix.
# Cache added-line sets per file in /tmp for the duration of this run.
ADDED_LINES_CACHE_DIR="/tmp/shippable-$$"
mkdir -p "$ADDED_LINES_CACHE_DIR"
trap 'rm -rf "$ADDED_LINES_CACHE_DIR"' EXIT

build_added_lines_for_file() {
  local f="$1"
  local cache_file="$ADDED_LINES_CACHE_DIR/$(echo "$f" | tr '/' '_').added"
  [[ -f "$cache_file" ]] && return 0

  # Untracked files (new): all lines are added.
  if ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
    if [[ -f "$f" ]]; then
      awk 'NR { print NR }' "$f" > "$cache_file"
    else
      : > "$cache_file"
    fi
    return 0
  fi

  # Tracked: parse hunk bodies line-by-line. Only `+` lines (excluding `+++`
  # file markers) are true additions; context and `-` lines don't count.
  # Hunk headers tell us where the new-file line counter starts.
  git diff "$BASE" -- "$f" --unified=0 2>/dev/null | awk '
    /^\+\+\+ / { in_hunk = 0; next }
    /^--- /    { in_hunk = 0; next }
    /^@@/ {
      if (match($0, /\+([0-9]+)/)) {
        cur_line = substr($0, RSTART+1, RLENGTH-1) + 0
        in_hunk = 1
      }
      next
    }
    in_hunk && /^\+/ {
      print cur_line
      cur_line++
      next
    }
    in_hunk && /^-/ { next }              # removed: no new-line advance
    in_hunk && /^[ ]/ { cur_line++; next } # context: advance counter
    in_hunk && /^\\/ { next }              # "\ No newline at end of file"
  ' > "$cache_file"
}

is_line_added() {
  local f="$1" line="$2"
  local cache_file="$ADDED_LINES_CACHE_DIR/$(echo "$f" | tr '/' '_').added"
  [[ -f "$cache_file" ]] || build_added_lines_for_file "$f"
  grep -qFx "$line" "$cache_file"
}

emit() {
  local gate="$1" severity="$2" file="$3" line="$4" evidence="$5" fix="$6"
  # Diff-aware suppression: skip findings on lines that were not added in this
  # diff. Pre-existing content in modified files is upstream's responsibility,
  # not the fork's.
  if [[ "${GBRAIN_SHIPPABLE_FULL_FILE:-0}" != "1" ]]; then
    is_line_added "$file" "$line" || return 0
  fi
  if [[ "$severity" == "blocking" ]]; then BLOCKING=$((BLOCKING+1)); else WARNINGS=$((WARNINGS+1)); fi
  local ev fx
  ev=$(printf '%s' "$evidence" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
  fx=$(printf '%s' "$fix" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
  printf '{"gate":"%s","severity":"%s","file":"%s","line":%s,"evidence":"%s","fix_hint":"%s"}\n' \
    "$gate" "$severity" "$file" "$line" "$ev" "$fx"
}

# --- Gate: OBSERVABILITY — empty catch blocks (multi-line aware) ---
# Detects:
#   } catch {}                                  (single-line empty)
#   } catch (e) {}                              (single-line empty with var)
#   } catch { /* anything */ }                  (single-line comment-only)
#   } catch {<newline>// comment<newline>}      (multi-line comment-only)
#   } catch {<newline>}                         (multi-line empty)
check_empty_catches() {
  local f="$1"
  case "$f" in *.ts|*.js) ;; *) return 0 ;; esac
  [[ -f "$f" ]] || return 0

  # awk state machine: when we see `catch ... {`, start capturing until matching `}`,
  # checking if any non-comment, non-whitespace content appears.
  awk -v file="$f" '
    {
      # Detect start of catch block
      if (match($0, /catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{/)) {
        catch_start = NR
        catch_evidence = $0
        # Strip everything before the catch
        rest = substr($0, RSTART + RLENGTH)
        depth = 1
        has_content = 0
        # Check the rest of this line (after the {)
        # Strip /* ... */ comments
        gsub(/\/\*[^*]*\*\//, "", rest)
        # Strip // ... comments
        sub(/\/\/.*/, "", rest)
        # Count braces
        for (i = 1; i <= length(rest); i++) {
          c = substr(rest, i, 1)
          if (c == "{") depth++
          else if (c == "}") {
            depth--
            if (depth == 0) {
              # Check if anything before this } was non-whitespace
              prefix = substr(rest, 1, i - 1)
              gsub(/[[:space:]]/, "", prefix)
              if (length(prefix) > 0) has_content = 1
              if (!has_content) {
                printf "%d\t%s\n", catch_start, catch_evidence
              }
              catch_start = 0
              break
            }
          } else if (c !~ /[[:space:]]/) {
            has_content = 1
          }
        }
        next
      }
      # If we are inside a catch block, accumulate
      if (catch_start) {
        line = $0
        gsub(/\/\*[^*]*\*\//, "", line)
        sub(/\/\/.*/, "", line)
        for (i = 1; i <= length(line); i++) {
          c = substr(line, i, 1)
          if (c == "{") depth++
          else if (c == "}") {
            depth--
            if (depth == 0) {
              prefix = substr(line, 1, i - 1)
              gsub(/[[:space:]]/, "", prefix)
              if (length(prefix) > 0) has_content = 1
              if (!has_content) {
                printf "%d\t%s\n", catch_start, catch_evidence
              }
              catch_start = 0
              break
            }
          } else if (c !~ /[[:space:]]/) {
            has_content = 1
          }
        }
      }
    }
  ' "$f" > /tmp/shippable-catch-$$.txt
  while IFS=$'\t' read -r line evidence; do
    emit "OBSERVABILITY" "blocking" "$f" "$line" "$evidence" \
      "Empty catch swallows errors silently. Replace with structured logging: catch (e) { console.warn('[<context>] failed: %s', e instanceof Error ? e.message : String(e)); }"
  done < /tmp/shippable-catch-$$.txt
  rm -f /tmp/shippable-catch-$$.txt
}

# --- Gate: OBSERVABILITY — bulk operations without progress reporter ---
check_missing_progress() {
  local f="$1"
  case "$f" in src/*.ts|src/*/*.ts|src/*/*/*.ts|src/*/*/*/*.ts) ;; *) return 0 ;; esac
  [[ -f "$f" ]] || return 0

  if grep -qE 'for[[:space:]]*\(.*[[:space:]]of[[:space:]]+(pages|files|entries|items|candidates|results)\b' "$f" 2>/dev/null && \
     ! grep -q "createProgress\|startHeartbeat\|onProgress" "$f" 2>/dev/null; then
    local line
    line=$(grep -nE 'for[[:space:]]*\(.*[[:space:]]of[[:space:]]+(pages|files|entries|items|candidates|results)\b' "$f" | head -1 | cut -d: -f1)
    emit "OBSERVABILITY" "warning" "$f" "${line:-1}" \
      "Bulk loop over pages/files/entries with no progress reporter import" \
      "If this loop is bulk (>100 iter) consider createProgress from src/core/progress.ts. Skip if loop is bounded small."
  fi
}

# --- Gate: CONTRACT — exported Report types missing schema_version ---
check_report_schema_version() {
  local f="$1"
  case "$f" in *.ts) ;; *) return 0 ;; esac
  [[ -f "$f" ]] || return 0

  awk '
    /^export interface [A-Z][A-Za-z0-9_]*Report\b/ {
      iface_name = $3; iface_line = NR; in_iface = 1; found_schema = 0; next
    }
    in_iface && /schema_version[[:space:]]*:/ { found_schema = 1 }
    in_iface && /^}/ {
      if (!found_schema) print iface_name "\t" iface_line
      in_iface = 0
    }
  ' "$f" > /tmp/shippable-schema-$$.txt
  while IFS=$'\t' read -r name line; do
    emit "CONTRACT" "blocking" "$f" "$line" \
      "interface ${name} has no schema_version field" \
      "Add 'schema_version: \"1\"' as a literal-typed field. Agents need this to detect output-shape changes across versions."
  done < /tmp/shippable-schema-$$.txt
  rm -f /tmp/shippable-schema-$$.txt
}

# --- Gate: INTEGRATION — raw SQL outside engine implementations ---
check_engine_bypass() {
  local f="$1"
  case "$f" in *.ts) ;; *) return 0 ;; esac
  [[ -f "$f" ]] || return 0

  # Engine implementations and migration code are allowed raw SQL
  case "$f" in
    src/core/*-engine.ts|src/core/migrate.ts|src/core/db.ts|src/core/pglite-schema.ts|src/schema*.ts|src/core/utils.ts) return 0 ;;
  esac

  grep -nE 'sql[[:space:]]*`(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b' "$f" 2>/dev/null > /tmp/shippable-sql-$$.txt || true
  while IFS=':' read -r line evidence; do
    [[ -z "$line" ]] && continue
    emit "INTEGRATION" "warning" "$f" "$line" "$evidence" \
      "Raw SQL outside engine implementations. Reach into BrainEngine methods instead. If new capability, add it to the engine interface first."
  done < /tmp/shippable-sql-$$.txt
  rm -f /tmp/shippable-sql-$$.txt
}

# --- Upstream-identical exemption ---
# A file that's byte-identical to upstream/master represents debt the fork
# didn't introduce. Don't block the ship on inherited upstream patterns.
# Newly-modified or fork-only files run gates normally.
#
# Set GBRAIN_NO_UPSTREAM_EXEMPT=1 to disable (e.g. for upstream-bound PRs
# where you DO want to clean up inherited debt before submitting).
EXEMPTED=0
is_upstream_identical() {
  local f="$1"
  [[ "${GBRAIN_NO_UPSTREAM_EXEMPT:-0}" == "1" ]] && return 1
  git rev-parse --verify upstream/master >/dev/null 2>&1 || return 1
  git ls-tree upstream/master -- "$f" >/dev/null 2>&1 || return 1
  [[ -z "$(git diff upstream/master -- "$f" 2>/dev/null)" ]]
}

# --- Run all checks against the file list ---
for f in "${FILES[@]}"; do
  if is_upstream_identical "$f"; then
    EXEMPTED=$((EXEMPTED+1))
    continue
  fi
  check_empty_catches "$f"
  check_missing_progress "$f"
  check_report_schema_version "$f"
  check_engine_bypass "$f"
done

# --- Summary line at end (machine-readable) ---
printf '{"summary":{"blocking_count":%d,"warning_count":%d,"upstream_exempted_files":%d}}\n' "$BLOCKING" "$WARNINGS" "$EXEMPTED"

# --- Exit code ---
[[ "$BLOCKING" -eq 0 ]]
