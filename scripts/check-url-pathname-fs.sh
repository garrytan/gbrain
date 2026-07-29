#!/usr/bin/env bash
# CI guard: fail if any source file derives a FILESYSTEM path from
# `new URL(...).pathname` (or `pathToFileURL(...).pathname`).
#
# `URL.pathname` is a *URL* path, not a filesystem path. On Windows
# `new URL('..', import.meta.url).pathname` yields `/C:/Users/...` — leading
# slash, forward separators, still percent-encoded — which no Win32 API
# accepts. The two ways that bites:
#
#   - as `cwd:` to `Bun.spawn`, libuv can't chdir and reports
#     `ENOENT: no such file or directory, uv_spawn 'bun'`. The `path: "bun"` in
#     that error is argv[0] echoed back, NOT the missing directory — so the
#     failure reads as "bun is not installed" and sends you hunting the wrong
#     defect.
#   - interpolated into a script argument, Bun reports
#     `Module not found "/C:/.../src/cli.ts"`.
#
# It is an IDENTITY TRANSFORM on POSIX, so Linux CI never surfaces it. That is
# exactly what makes it a silent-reintroduction risk and why this guard exists:
# the ~20 occurrences fixed in 6ba694ec were all green on CI the whole time.
#
# The fix is `fileURLToPath()` from `node:url` (handles drive letter, separators
# and percent-decoding), or `import.meta.dir`. Tests should use the shared
# `REPO_ROOT` / `repoPath()` helper in `test/helpers/repo-root.ts`.
#
# WHAT IS FLAGGED (all three require a *file* URL — HTTP/postgres URLs are left
# alone, since `.pathname` is the correct accessor there):
#   1. `new URL(..., import.meta.url).pathname`  — same logical expression
#   2. `new URL('file://…').pathname` / `pathToFileURL(x).pathname`
#   3. two-step: `const u = new URL('..', import.meta.url)` … later `u.pathname`
#
# WHAT IS NOT FLAGGED:
#   - `.pathname` on any URL not derived from `import.meta.url` / a `file:`
#     literal / `pathToFileURL` — parsing a connection string, routing an HTTP
#     request, assigning `u.pathname = '/db'`, etc.
#   - comments (line + block are stripped, so the JSDoc that documents this very
#     rule doesn't trip it).
#   - any line carrying an explicit `url-pathname-guard-ok` opt-out marker.
#
# Heuristic by design (line-oriented scan with bounded continuation joining,
# not a parser). String literals are not distinguished from code, and a line
# comment split inside a regex literal containing `//` truncates the scan of
# that line. The behavioral backstop is `test/helpers/repo-root.test.ts`, whose
# assertions fail against the old expression on Windows.
#
# Usage:
#   bash scripts/check-url-pathname-fs.sh            # scan the git-tracked tree
#   bash scripts/check-url-pathname-fs.sh DIR [DIR…] # scan explicit dirs (fixtures)
#
# Exit: 0 when clean, 1 when violations found.

set -uo pipefail

IN_GIT=0
if [ "$#" -eq 0 ]; then
  # One rev-parse serves double duty: the repo root to scan from, and the
  # "is this a git checkout" signal that picks the file-listing strategy.
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$ROOT" ]; then
    IN_GIT=1
  else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  fi
  cd "$ROOT" || exit 1
fi

SRC_EXT_RE='\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$'
SKIP_RE='(^|/)(node_modules|dist|build|coverage|\.next|\.git)/|\.min\.js$'

# Every violation shape contains the literal `pathname`, so a file-level
# prefilter is sound (the two-step var form binds and reads in the same file)
# and it is what keeps the guard fast: `git grep` narrows ~2k source files to a
# handful before the line scanner reads anything.
PROBE='pathname'

list_files() {
  if [ "$IN_GIT" = 1 ]; then
    # --untracked so a not-yet-added file is still gated locally; .gitignore is
    # still honored, so node_modules stays out.
    git grep -lI --untracked -e "$PROBE" -- \
      '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null |
      grep -vE "$SKIP_RE" || true
  else
    # Explicit roots (the guard's own test points this at fixture dirs that are
    # not git repos), or a non-git checkout: plain find + grep.
    local cand
    cand="$(find "${@:-.}" -type f 2>/dev/null | grep -E "$SRC_EXT_RE" | grep -vE "$SKIP_RE")"
    [ -n "$cand" ] || return 0
    printf '%s\n' "$cand" | tr '\n' '\0' | xargs -0 grep -lE "$PROBE" 2>/dev/null || true
  fi
}

read -r -d '' AWK_PROG <<'AWK_EOF'
# Blank out comments. Scheme separators are neutralized first so `https://x`
# is not mistaken for the start of a line comment.
function strip(s,   i, j, t) {
  gsub(/:\/\//, ":\001\001", s)
  if (inblock) {
    i = index(s, "*/")
    if (i == 0) return ""
    inblock = 0
    s = substr(s, i + 2)
  }
  while ((i = index(s, "/*")) > 0) {
    t = substr(s, i + 2)
    j = index(t, "*/")
    if (j == 0) { s = substr(s, 1, i - 1); inblock = 1; break }
    s = substr(s, 1, i - 1) " " substr(s, i + j + 3)
  }
  i = index(s, "//")
  if (i > 0) s = substr(s, 1, i - 1)
  return s
}

function unprot(s) { gsub(/:\001\001/, "://", s); return s }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

# Does this expression build a URL out of a module/file URL?
function fileurl(t) {
  return (t ~ /import\.meta\.url/) || (t ~ /pathToFileURL[ \t]*\(/) || (t ~ /["'`]file:/)
}
function ctor(t) { return (t ~ /new[ \t]+URL[ \t]*\(/) || (t ~ /pathToFileURL[ \t]*\(/) }

# Paren balance via gsub's substitution count (cheap; no per-char loop).
function pdelta(s,   a, b, t1, t2) {
  t1 = s; t2 = s
  a = gsub(/\(/, "(", t1)
  b = gsub(/\)/, ")", t2)
  return a - b
}

function report(f, l, t, why,   key, txt) {
  key = f ":" l
  if (key in seen) return
  seen[key] = 1
  txt = trim(unprot(t))
  if (length(txt) > 140) txt = substr(txt, 1, 137) "..."
  printf "  %s:%d\n      %s\n      %s\n", f, l, txt, why
}

function check(t, lno,   seg, v, esc) {
  # Remember variables bound to a file URL, for the two-step form.
  if (fileurl(t) && ctor(t)) {
    if (match(t, /(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*(new[ \t]+URL|pathToFileURL)[ \t]*\(/)) {
      seg = substr(t, RSTART, RLENGTH)
      sub(/^(const|let|var)[ \t]+/, "", seg)
      if (match(seg, /^[A-Za-z_$][A-Za-z0-9_$]*/)) fv[substr(seg, 1, RLENGTH)] = 1
    }
  }

  if (t !~ /\.pathname/) return

  if (fileurl(t) && ctor(t)) {
    report(FILENAME, lno, t,
      "URL built from import.meta.url / a file: literal / pathToFileURL — its .pathname is a URL path (\"/C:/...\" on Windows), not a filesystem path")
    return
  }

  for (v in fv) {
    esc = v; gsub(/\$/, "\\$", esc)
    if (t ~ ("(^|[^A-Za-z0-9_$.])" esc "\\.pathname")) {
      if (t ~ (esc "\\.pathname[ \t]*=[^=]")) continue   # assignment, not a read
      report(FILENAME, lno, t,
        "`" v "` holds a file URL; its .pathname is a URL path, not a filesystem path")
      return
    }
  }
}

FNR == 1 { inblock = 0; delete fv; pending = ""; pline = 0; pdep = 0; pj = 0; prev = ""; prevline = 0 }

{
  code = strip($0)
  if ($0 ~ /url-pathname-guard-ok/) { pending = ""; prev = ""; next }

  # Continuation of a multi-line `new URL(` call: keep joining until the call's
  # parens balance (bounded, so an unbalanced line can't swallow the file).
  if (pending != "") {
    pending = pending " " code
    pdep += pdelta(code)
    pj++
    if (pdep <= 0 || pj >= 6) { check(pending, pline); pending = ""; pj = 0; prev = "" }
    next
  }

  if (code ~ /new[ \t]+URL[ \t]*\(/ && pdelta(code) > 0) {
    pending = code; pline = FNR; pdep = pdelta(code); pj = 0
    next
  }

  # `new URL(...)` \n `.pathname` — a leading-dot line continues the previous one.
  if (code ~ /^[ \t]*\./ && prev != "") check(prev " " code, prevline)
  check(code, FNR)
  prev = code; prevline = FNR
}
AWK_EOF

LIST="$(list_files "$@")"

if [ -z "$LIST" ]; then
  echo "check-url-pathname-fs: ok (no candidate files)"
  exit 0
fi

OUT="$(printf '%s\n' "$LIST" | tr '\n' '\0' | xargs -0 awk "$AWK_PROG" || true)"

if [ -n "$OUT" ]; then
  {
    echo "ERROR: URL.pathname used as a filesystem path:"
    echo
    echo "$OUT"
    echo "Use fileURLToPath() from 'node:url' (or import.meta.dir) instead:"
    echo
    echo "    import { fileURLToPath } from 'node:url';"
    echo "    const dir = fileURLToPath(new URL('..', import.meta.url));"
    echo
    echo "In tests, prefer the shared helper: import { REPO_ROOT, repoPath } from"
    echo "'test/helpers/repo-root.ts'. URL.pathname is an identity transform on"
    echo "POSIX, so a green Linux CI run does NOT mean this works on Windows."
    echo
    echo "If a flagged line really is a URL path (not a filesystem path), append"
    echo "a 'url-pathname-guard-ok' comment to it with the reason."
  } >&2
  exit 1
fi

echo "check-url-pathname-fs: ok (no URL.pathname filesystem paths; $(printf '%s\n' "$LIST" | wc -l | tr -d ' ') candidate file(s) scanned)"
