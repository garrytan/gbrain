#!/usr/bin/env bash
# CI guard (#6530): agent-facing docs never teach git commands that are unsafe
# in a brain checkout other agents share.
#
# Many writers (sessions, sub-agents, crons, hooks, a host sync daemon) commit
# to one brain checkout. A rebase there stashes every other writer's edits,
# a repo-wide add commits their half-written files, and a reset or force push
# discards them. Agents follow skills, recipes, templates and docs literally,
# so this guard fails when one of them teaches, in a code block or an inline
# code span:
#
#   git pull --rebase (or -r)   --autostash        git stash (not store/list/show)
#   git add -A / --all / .      (unless followed by `--`, i.e. explicit paths)
#   git commit -a / -am / --all git reset --hard    git push --force / -f / +ref
#   any other git push (bare push; `git push --dry-run` is read-only and allowed)
#
# The safe replacement is `scripts/brain-commit-push.sh` or
# `gbrain git commit-push` (docs/guides/shared-checkout-git.md).
#
# Scanned: skills/, recipes/, templates/, docs/, plugin/, plugin-variants/
# (*.md, *.template, *.sh) plus AGENTS.md, BOOTSTRAP_FOR_AGENTS.md and
# INSTALL_FOR_AGENTS.md. In markdown only fenced code blocks and inline code
# spans are checked; a .sh file is checked whole.
#
# Not scanned:
#   - docs/guides/error-codes.md: generated from src/core/error-registry.ts.
#   - docs/RELEASING.md, docs/TESTING.md, docs/contributing/ (and
#     CONTRIBUTING.md, CHANGELOG.md, TODOS.md at the root, which are outside
#     the scanned set): they describe maintainers working in the gbrain SOURCE
#     repository, not agents writing to a brain checkout.
#   - historical records: docs/designs/, docs/plans/, docs/proposals/,
#     docs/research/, docs/incidents/, docs/issues/, docs/test-audit/,
#     docs/superpowers/.
#
# Allow a line that must name one of these (a warning, a single-writer clone):
#   same line, inside a code block:   <cmd>  # gbrain-allow-shared-tree-git: <reason>
#   line before, in prose:            <!-- gbrain-allow-shared-tree-git: <reason> -->
#   a region (a "never run" list):    <!-- gbrain-allow-shared-tree-git-begin: <reason> -->
#                                     ...
#                                     <!-- gbrain-allow-shared-tree-git-end -->
# A marker without a reason fails.
#
# Also checks that the "Multi-agent rules" block (between
# `<!-- BEGIN multi-agent-rules -->` and `<!-- END multi-agent-rules -->`) is
# present and identical in every one of AGENTS.md, BOOTSTRAP_FOR_AGENTS.md and
# INSTALL_FOR_AGENTS.md that exists.
#
# Run:   bash scripts/check-shared-tree-git.sh [file ...]
#        (with files: scan only those, relative to the root; no block check)
# Wired into `bun run verify` via package.json `check:shared-tree-git`.
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 2

EXEMPT='^(CHANGELOG\.md|TODOS\.md|CONTRIBUTING\.md|docs/guides/error-codes\.md|docs/RELEASING\.md|docs/TESTING\.md|docs/contributing/|docs/(designs|plans|proposals|research|incidents|issues|test-audit|superpowers)/)'
SEE='docs/guides/shared-checkout-git.md'

LIST="$(mktemp -t gbrain-shared-tree-git-XXXXXX)" || exit 2
trap 'rm -f "$LIST"' EXIT

if [ "$#" -gt 0 ]; then
  for f in "$@"; do printf '%s\n' "${f#./}"; done >"$LIST"
  block_check=0
else
  {
    for f in AGENTS.md BOOTSTRAP_FOR_AGENTS.md INSTALL_FOR_AGENTS.md; do
      [ -f "$f" ] && printf '%s\n' "$f"
    done
    for d in skills recipes templates docs plugin plugin-variants; do
      [ -d "$d" ] || continue
      find "$d" -name node_modules -prune -o -type f \( -name '*.md' -o -name '*.template' -o -name '*.sh' \) -print
    done
  } | sed 's|^\./||' | grep -vE "$EXEMPT" | LC_ALL=C sort >"$LIST"
  block_check=1
fi

# Read with `read -d ''`, never a heredoc inside $(...): macOS /bin/bash 3.2
# quote-scans that form and dies on the quotes in this program.
IFS= read -r -d '' AWK_PROG <<'EOF' || true
function report(kind, frag,   fix) {
  if (kind == "pull-rebase" || kind == "autostash") fix = "bring remote commits in with `scripts/brain-commit-push.sh --pull` or `gbrain git commit-push --pull`; a rebase stashes every other writer's edits"
  else if (kind == "stash") fix = "never stash a shared checkout; commit only your own paths with `gbrain git commit-push -m <msg> -- <paths>` (git stash store/list/show are allowed)"
  else if (kind == "add-all" || kind == "commit-all") fix = "stage only the files you wrote: `scripts/brain-commit-push.sh \"<msg>\" <paths>` or `gbrain git commit-push -m <msg> -- <paths>`"
  else if (kind == "reset-hard") fix = "never reset a shared checkout; it discards other writers' edits (see #stuck-rebase for recovery)"
  else if (kind == "force-push") fix = "never force-push a brain; a deliberate history rewrite in a private clone carries an allow marker with its reason"
  else if (kind == "push") fix = "publish with `scripts/brain-commit-push.sh` or `gbrain git commit-push` (`--push-only` for commits already made); they take the writer lock and merge a rejected push safely"
  else fix = "give the marker its reason: `gbrain-allow-shared-tree-git: <reason>` (or `-begin: <reason>`)"
  printf "FAIL: %s:%d %s \"%s\"\n", FILENAME, FNR, kind, frag
  printf "Why:  agents follow this text literally in brain checkouts other agents share.\n"
  printf "Fix:  %s.\n", fix
  printf "See:  %s\n", see
}

function unclosed(f) {
  printf "FAIL: %s:%d unclosed allow region\n", f, blockline
  printf "Why:  a gbrain-allow-shared-tree-git-begin marker without its end exempts the rest of the file.\n"
  printf "Fix:  close the region with <!-- gbrain-allow-shared-tree-git-end --> right after the lines it covers.\n"
  printf "See:  %s\n", see
}

function strip(tok) { gsub(/["'`();,]+$/, "", tok); gsub(/^["'`(]+/, "", tok); return tok }

function check(t,   s, m, n, parts, i, sub1) {
  # git pull --rebase / -r
  s = t
  while (match(s, G "pull[^|;&]*")) {
    m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    if (m ~ /--rebase/ || m ~ / -r( |$)/) { report("pull-rebase", m); return }
  }
  if (t ~ /--autostash/) { report("autostash", "--autostash"); return }
  s = t
  while (match(s, G "stash( +[a-z]+)?")) {
    m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    if (m !~ /stash +(store|list|show)$/) { report("stash", m); return }
  }
  s = t
  while (match(s, G "add +[^ ]+( +[^ ]+)?")) {
    m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    sub1 = m; sub(/^.*add +/, "", sub1)
    n = split(sub1, parts, / +/)
    parts[1] = strip(parts[1]); if (n >= 2) parts[2] = strip(parts[2]); else parts[2] = ""
    if (parts[1] == "." || ((parts[1] == "-A" || parts[1] == "--all") && parts[2] != "--")) { report("add-all", m); return }
  }
  if (match(t, G "commit +(-[A-Za-z]*a[A-Za-z]*|--all)([^A-Za-z-]|$)")) { report("commit-all", substr(t, RSTART, RLENGTH)); return }
  if (match(t, G "reset[^|;&]*--hard")) { report("reset-hard", substr(t, RSTART, RLENGTH)); return }
  s = t
  while (match(s, G "push([^A-Za-z0-9_-][^|;&]*)?$") || match(s, G "push([^A-Za-z0-9_-][^|;&]*)?[|;&]")) {
    m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    if (m ~ /--dry-run/ || m ~ / -n( |$)/) continue
    if (m ~ /--force/ || m ~ / -f( |$|[^A-Za-z])/ || m ~ / \+[^ ]/) { report("force-push", m); return }
    report("push", m); return
  }
}

BEGIN { G = "(^|[^A-Za-z0-9_.-])git( +-[Cc] +[^ ]+)* +" }

FNR == 1 {
  if (lastfile != "" && inblock) unclosed(lastfile)
  lastfile = FILENAME; infence = 0; inblock = 0; prevallow = 0; issh = (FILENAME ~ /\.sh$/)
}

{
  line = $0
  allow = prevallow
  prevallow = 0
  if (index(line, "gbrain-allow-shared-tree-git")) {
    if (line ~ /^[ \t]*<!-- *gbrain-allow-shared-tree-git-begin: *[^ \t-].*-->[ \t]*$/) { inblock = 1; blockline = FNR; next }
    if (line ~ /^[ \t]*<!-- *gbrain-allow-shared-tree-git-end *-->[ \t]*$/) { inblock = 0; next }
    if (line ~ /^[ \t]*<!-- *gbrain-allow-shared-tree-git: *[^ \t-].*-->[ \t]*$/) { prevallow = 1; next }
    if (line ~ /gbrain-allow-shared-tree-git(-begin)?: *(-->)?[ \t]*$/) { report("allow-marker-without-reason", line); next }
    if (line ~ /gbrain-allow-shared-tree-git: *[^ \t-]/) allow = 1
  }
  if (!issh && line ~ /^[ \t]*(```|~~~)/) { infence = !infence; next }
  if (allow || inblock) next
  if (issh || infence) { check(line); next }
  if (index(line, "`") == 0) next
  n = split(line, parts, "`")
  for (i = 2; i <= n; i += 2) check(parts[i])
}

END { if (lastfile != "" && inblock) unclosed(lastfile) }
EOF

out=""
if [ -s "$LIST" ]; then
  out="$(tr '\n' '\0' <"$LIST" | xargs -0 awk -v see="$SEE" "$AWK_PROG" 2>&1)"
fi

block_fail=""
if [ "$block_check" -eq 1 ]; then
  ref=""; ref_file=""
  for f in AGENTS.md BOOTSTRAP_FOR_AGENTS.md INSTALL_FOR_AGENTS.md; do
    [ -f "$f" ] || continue
    blk="$(sed -n '/<!-- BEGIN multi-agent-rules/,/<!-- END multi-agent-rules -->/p' "$f")"
    if [ -z "$blk" ]; then
      block_fail="${block_fail}FAIL: $f has no Multi-agent rules block
Why:  every agent entry doc must carry the shared-checkout rules.
Fix:  copy the block between <!-- BEGIN multi-agent-rules --> and <!-- END multi-agent-rules --> from AGENTS.md.
See:  $SEE
"
      continue
    fi
    if [ -z "$ref_file" ]; then ref="$blk"; ref_file="$f"
    elif [ "$blk" != "$ref" ]; then
      block_fail="${block_fail}FAIL: $f Multi-agent rules block differs from $ref_file
Why:  the three agent entry docs must give agents the same rules.
Fix:  make the block between <!-- BEGIN multi-agent-rules --> and <!-- END multi-agent-rules --> identical in AGENTS.md, BOOTSTRAP_FOR_AGENTS.md and INSTALL_FOR_AGENTS.md.
See:  $SEE
"
    fi
  done
fi

if [ -n "$out" ] || [ -n "$block_fail" ]; then
  [ -n "$out" ] && printf '%s\n' "$out" >&2
  [ -n "$block_fail" ] && printf '%s' "$block_fail" >&2
  hits=$(printf '%s\n%s' "$out" "$block_fail" | grep -c '^FAIL:')
  echo "" >&2
  echo "✗ shared-tree git: $hits hit(s); see $SEE" >&2
  exit 1
fi
echo "✓ shared-tree git: no unsafe git commands in skills, recipes, templates, docs, plugin trees or agent docs"
