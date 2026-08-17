#!/usr/bin/env bash
# Wave security scan — the repeatable mechanical sweep for community-PR waves.
#
# Runs the high-recall checks a maintainer should apply to a batch of external
# contributions BEFORE shipping a collector branch (see docs/RELEASING.md,
# "Community PR wave process"). It is NOT a proof of safety — it is a fast net
# that surfaces the shapes worth a human look: newly-introduced outbound
# endpoints, obfuscation/eval, new process spawns, new env reads, dependency
# changes, secrets (gitleaks with the test/skills allowlist STRIPPED), and any
# change to the committed admin bundle.
#
# Usage:
#   scripts/wave-security-scan.sh <base>..<head>     # explicit range
#   scripts/wave-security-scan.sh <base> <head>      # two refs
#   scripts/wave-security-scan.sh                    # defaults to origin/master..HEAD
#   scripts/wave-security-scan.sh --json <range>     # machine-readable summary
#
# Exit code: 0 = nothing high-signal; 1 = high-signal hit(s) worth review;
#            2 = usage / environment error. Findings are advisory: exit 1 means
#            "look", not "unsafe".
#
# On-demand only (never wired into the hot CI path): gitleaks-over-history and
# the per-file diff walk are too slow for every push.

set -euo pipefail
# Deliberately NO cd-to-script-repo: the scan operates on the CALLER's git repo
# (the collector branch being reviewed), which is not necessarily the repo this
# script lives in. The not-a-git-repository guard below handles stray cwds.

JSON=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# --- Resolve the commit range (guard empty / non-git / bad refs) ---
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "wave-security-scan: not a git repository" >&2
  exit 2
fi
# Operate on the CALLER's repo, but ROOTED at its top level. Without this, a run
# from a subdirectory would scope every cwd-relative pathspec (`-- .`, root
# manifests, `admin/dist`) to the subtree and silently report a clean gate.
_TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wave-security-scan: cannot resolve repo top level" >&2; exit 2; }
cd "$_TOPLEVEL"
# python3 does the regex/JSON work; without it the checks can't run and set -e
# would exit 127 outside the documented 0/1/2 contract. Fail as a usage error.
if ! command -v python3 >/dev/null 2>&1; then
  echo "wave-security-scan: python3 is required but not found" >&2
  exit 2
fi

RANGE=""
if [ "${#ARGS[@]}" -eq 0 ]; then
  if git rev-parse --verify -q origin/master >/dev/null; then
    RANGE="origin/master..HEAD"
  else
    RANGE="HEAD~1..HEAD"
  fi
elif [ "${#ARGS[@]}" -eq 1 ]; then
  RANGE="${ARGS[0]}"
elif [ "${#ARGS[@]}" -eq 2 ]; then
  RANGE="${ARGS[0]}..${ARGS[1]}"
else
  echo "wave-security-scan: too many arguments" >&2
  exit 2
fi

# Normalise `a..b`; verify both endpoints resolve.
BASE="${RANGE%%..*}"
HEAD="${RANGE##*..}"
if [ "$BASE" = "$RANGE" ] || [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "wave-security-scan: range must be <base>..<head> (got '$RANGE')" >&2
  exit 2
fi
if ! git rev-parse --verify -q "$BASE^{commit}" >/dev/null || ! git rev-parse --verify -q "$HEAD^{commit}" >/dev/null; then
  echo "wave-security-scan: cannot resolve one end of '$RANGE'" >&2
  exit 2
fi

COMMIT_COUNT=$(git rev-list --count "$RANGE" 2>/dev/null || echo 0)
if [ "$COMMIT_COUNT" -eq 0 ]; then
  echo "wave-security-scan: empty range ($RANGE) — nothing to scan" >&2
  if [ "$JSON" -eq 1 ]; then
    # Same schema as the main --json path (zero/empty values), safely encoded.
    python3 -c 'import json,sys; print(json.dumps({"range": sys.argv[1], "commits": 0, "checks": {}, "alarm": 0, "dependency_changed": False, "admin_dist_changed": False, "gitleaks_hits": "n/a"}))' "$RANGE"
  fi
  exit 0
fi

# Generated / minified / vendored artifacts: excluded from the CONTENT greps
# (they trip every obfuscation heuristic and drown real signal), but admin/dist
# changes are still surfaced separately below (that is a real threat artifact).
is_scannable() {
  case "$1" in
    admin/dist/*|*/admin/dist/*) return 1 ;;
    llms.txt|llms-full.txt) return 1 ;;
    *.snapshot|*.snap|*.tar|*.tgz|*.wasm|*.png|*.jpg|*.jpeg|*.gif|*.pdf|*.ico) return 1 ;;
    bun.lock|*/bun.lock|package-lock.json|yarn.lock) return 1 ;;
    *) return 0 ;;
  esac
}

TMP=$(mktemp -d /tmp/wave-scan.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# --- Build the added-line corpus (content-scannable files only) ---
: > "$TMP/added.txt"
# Anchor the file-header match to the git unified-diff form (`+++ b/<path>` or
# `+++ /dev/null`). A looser `^+++ ` also matches a CONTENT line like `++ x;`
# (a `++`-prefixed statement renders as `+++ x;`), which would reassign the
# current filename to garbage and suppress checks for the rest of the file.
git diff --no-color --unified=0 "$RANGE" -- . 2>/dev/null | awk '
  /^\+\+\+ (b\/|\/dev\/null)/{ f=$0; sub(/^\+\+\+ b\//,"",f); next }
  /^\+/ && !/^\+\+\+/ { line=$0; sub(/^\+/,"",line); print f"\t"line }
' > "$TMP/added_all.txt" || true
while IFS=$'\t' read -r f rest; do
  [ -z "$f" ] && continue
  if is_scannable "$f"; then printf '%s\t%s\n' "$f" "$rest" >> "$TMP/added.txt"; fi
done < "$TMP/added_all.txt"

# Python does the regex work (BSD grep/ugrep differ; python is portable).
python3 - "$TMP/added.txt" "$TMP" <<'PY'
import re, sys, json
added = sys.argv[1]; tmp = sys.argv[2]
rows = []
for line in open(added, encoding='utf-8', errors='replace').read().splitlines():
    p = line.split('\t', 1)
    if len(p) == 2:
        rows.append(p)

CODE_EXT = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.bash')
SHELL_EXT = ('.sh', '.bash')
def is_code(f):
    return f.endswith(CODE_EXT)
def is_test(f):
    return f.startswith('test/') or '/test/' in f or f.startswith('skills/')
# Execution-reachable source: src/scripts + admin/src (the release job now builds
# and embeds admin/src, so its spawns/env reads matter too).
def is_exec_source(f):
    return f.startswith(('src/', 'scripts/', 'admin/src/'))
def is_comment(f, c):
    # Only suppress lines that genuinely can't execute. Do NOT over-broaden:
    # a leading `#` is a comment only in shell (in JS/TS it's a private field);
    # a leading `*` is a comment only as `*/` or a JSDoc continuation `* ...`
    # (with a following space) — `*gen(){}` / `*eval(` are generator/multiply
    # constructs that DO execute.
    t = c.lstrip()
    if t.startswith('//') or t.startswith('/*') or t.startswith('*/'):
        return True
    if t.startswith('* ') or t == '*':
        return True
    if f.endswith(SHELL_EXT) and t.startswith('#'):
        return True
    return False

# Code-shaped checks fire on CODE FILES only (obfuscation/eval in a .md is prose,
# not a payload). ALARM checks (exit 1) are the low-false-positive ones:
# obfuscation/eval in executable code lines. The rest are INFORMATIONAL context.
# The obfuscation pattern covers JS call form `eval(`/`atob(`/`new Function(` AND
# shell forms `eval "$x"` / `eval $x` / `source <(...)`.
checks = {
  'obfuscation': (True, lambda f, c: is_code(f) and not is_comment(f, c) and bool(re.search(
        r'\beval\s*[("\'$]|\beval\s+\S|\bnew\s+Function\s*\(|\batob\s*\(|Buffer\.from\([^)]*[\'"]base64|String\.fromCharCode|\bsource\s+<\(|(\\x[0-9a-fA-F]{2}){4,}|[A-Za-z0-9+/]{120,}={0,2}', c))),
  'outbound_url': (False, lambda f, c: bool(re.search(r'https?://|wss?://', c))
        and not re.search(r'localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net|test|invalid)|\.example\b|schema|xmlns|w3\.org|json-schema|spdx|in-toto\.io|slsa\.dev|sigstore|githubusercontent|github\.com/garrytan/gbrain', c)),
  'new_spawn_exec': (False, lambda f, c: is_code(f) and bool(re.search(r'child_process|execSync|\bexecFileSync|\bspawnSync|\bspawn\s*\(|Bun\.spawn|shell\s*:\s*true', c)) and is_exec_source(f)),
  'new_env_read': (False, lambda f, c: is_code(f) and bool(re.search(r'(?:process|Bun)\.env[.\[]', c)) and is_exec_source(f)),
}
results = {k: [] for k in checks}
for f, c in rows:
    for k, (_alarm, pred) in checks.items():
        try:
            if pred(f, c):
                results[k].append((f, c.strip()[:160]))
        except re.error:
            pass

# alarm_total drives exit 1; informational checks are printed but never fail.
summary = {}
alarm_total = 0
for k, hits in results.items():
    alarm = checks[k][0]
    summary[k] = {'total': len(hits), 'alarm': alarm, 'sample': hits[:8]}
    if alarm:
        alarm_total += len(hits)

json.dump({'checks': summary, 'alarm': alarm_total}, open(tmp + '/checks.json', 'w'))
PY

# --- Dependency diff (root AND admin — the release job installs admin deps too) ---
DEP_CHANGED=0
if ! git diff --quiet "$RANGE" -- package.json bun.lock admin/package.json admin/bun.lock 2>/dev/null; then DEP_CHANGED=1; fi

# --- Admin bundle change (WS1 threat artifact — always flag for manual review) ---
ADMIN_DIST_CHANGED=0
if git diff --name-only "$RANGE" -- 'admin/dist' 2>/dev/null | grep -q .; then ADMIN_DIST_CHANGED=1; fi

# --- gitleaks with the test/skills allowlist STRIPPED (temp config; never edits repo .gitleaks.toml) ---
# Fail-closed lane: this script's exit code is the RELEASING.md step-5 gate, so a
# secrets sweep that DID NOT RUN (gitleaks missing) or ran-but-unparseable ("?")
# must alarm — never silently report clean.
GITLEAKS_HITS="n/a"
if command -v gitleaks >/dev/null 2>&1; then
  # extend useDefault = gitleaks' built-in rules WITHOUT the repo .gitleaks.toml
  # (which allowlists test/ + skills/) — the whole point is to see the blind spot.
  printf '[extend]\nuseDefault = true\n' > "$TMP/gitleaks.toml"
  if gitleaks git --no-banner -c "$TMP/gitleaks.toml" --log-opts="$RANGE" --report-format json --report-path "$TMP/leaks.json" >/dev/null 2>&1; then
    GITLEAKS_HITS=0
  else
    GITLEAKS_HITS=$(python3 -c "import json;print(len(json.load(open('$TMP/leaks.json'))))" 2>/dev/null || echo "?")
  fi
fi
LEAK_LANE_BROKEN=0
if [ "$GITLEAKS_HITS" = "n/a" ]; then
  echo "wave-security-scan: WARNING — gitleaks is not installed; the secrets lane DID NOT RUN (install gitleaks, then re-run)" >&2
  LEAK_LANE_BROKEN=1
elif [ "$GITLEAKS_HITS" = "?" ]; then
  echo "wave-security-scan: WARNING — gitleaks exited non-zero and its report is unreadable; the secrets lane result is UNKNOWN" >&2
  LEAK_LANE_BROKEN=1
fi

# --- Report ---
ALARM=$(python3 -c "import json;print(json.load(open('$TMP/checks.json'))['alarm'])")
LEAK_SIGNAL=0
if [ "$GITLEAKS_HITS" != "n/a" ] && [ "$GITLEAKS_HITS" != "0" ] && [ "$GITLEAKS_HITS" != "?" ]; then LEAK_SIGNAL=$GITLEAKS_HITS; fi

# Compute the gate result up front so --json carries it (a machine consumer must
# not read alarm:0 and conclude "clean" while the process exits 1 on an
# admin/dist change, a gitleaks hit, or a broken secrets lane).
GATE_EXIT=0
if [ "$ALARM" -gt 0 ] || [ "$LEAK_SIGNAL" -gt 0 ] || [ "$ADMIN_DIST_CHANGED" = 1 ] || [ "$LEAK_LANE_BROKEN" = 1 ]; then
  GATE_EXIT=1
fi

if [ "$JSON" -eq 1 ]; then
  python3 - "$TMP/checks.json" "$RANGE" "$COMMIT_COUNT" "$DEP_CHANGED" "$ADMIN_DIST_CHANGED" "$GITLEAKS_HITS" "$GATE_EXIT" "$LEAK_LANE_BROKEN" <<'PY'
import json, sys
checks = json.load(open(sys.argv[1]))
out = {
  'range': sys.argv[2], 'commits': int(sys.argv[3]),
  'checks': checks['checks'], 'alarm': checks['alarm'],
  'dependency_changed': sys.argv[4] == '1',
  'admin_dist_changed': sys.argv[5] == '1',
  'gitleaks_hits': sys.argv[6],
  'gitleaks_lane_broken': sys.argv[8] == '1',
  'exit_code': int(sys.argv[7]),
  'gate': 'review' if sys.argv[7] == '1' else 'clean',
}
print(json.dumps(out))
PY
else
  echo "wave-security-scan  range=$RANGE  commits=$COMMIT_COUNT"
  echo "  (ALARM = exit 1, worth review before ship; other rows are context)"
  echo "-------------------------------------------------------------"
  python3 - "$TMP/checks.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))['checks']
labels = {'obfuscation':'obfuscation / eval (code)','outbound_url':'new outbound URLs/hosts','new_spawn_exec':'new spawn/exec (src/scripts)','new_env_read':'new env reads (src)'}
for k, lab in labels.items():
    s = c[k]
    tag = 'ALARM' if s['alarm'] else 'info '
    flag = '  <-- REVIEW' if (s['alarm'] and s['total']) else ''
    print(f"  [{tag}] {lab:30} count={s['total']}{flag}")
    for f, snip in s['sample'][:4]:
        print(f"          {f}: {snip[:100]}")
PY
  echo "  [info ] dependency change (package.json/bun.lock): $([ "$DEP_CHANGED" = 1 ] && echo YES || echo no)"
  echo "  [ALARM] admin/dist change (bundle-backdoor artifact):  $([ "$ADMIN_DIST_CHANGED" = 1 ] && echo 'YES <-- REVIEW' || echo no)"
  echo "  [ALARM] gitleaks (test/skills allowlist stripped):     $GITLEAKS_HITS"
  echo "-------------------------------------------------------------"
fi

exit "$GATE_EXIT"
