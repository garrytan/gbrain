#!/usr/bin/env bash
# Repro: repair frontmatter treats file_drift holds of deleted/purged pages as "safe: Import as it is now" and revives them.
set -u
L=/var/tmp/audit/lifecycle; G="$L/g.sh h6"
rm -rf $L/h6 $L/repo3; mkdir -p $L/repo3/people
cd $L/repo3 && git init -q -b main && git config user.email a@example.com && git config user.name audit
printf -- '---\ntitle: Ivy Example\ntype: person\n---\n# Ivy Example\n\nIvy private note. Okapi keyword.\n' > people/ivy-example.md
printf -- '---\ntitle: Jon Example\ntype: person\n---\n# Jon Example\n\nJon note.\n' > people/jon-example.md
git add -A && git commit -qm init
$G init --pglite --no-embedding >/dev/null 2>&1; $G sources add notes --path $L/repo3 >/dev/null 2>&1
$G sync --source notes --no-pull 2>&1 | grep -E "imported"
echo "== purge ivy, soft-delete jon"
$G delete people/ivy-example --source-id notes --purge --force 2>&1 | grep -m1 '"status"'
$G delete people/jon-example --source-id notes --force 2>&1 | grep -m1 '"status"'
echo "== someone restores both files with one extra line and commits"
git checkout -- people && echo "one more line" >> people/ivy-example.md && echo "one more line" >> people/jon-example.md && git commit -qam "edit"
$G sync --source notes --no-pull 2>&1 | grep -E "^  Held" | cut -c1-200
echo "== repair frontmatter preview"
$G repair frontmatter --source notes 2>&1 | grep -E "safe:|item|apply:" | head -8
H=$($G repair frontmatter --source notes --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('plan_hash') or d.get('expect') or '')" 2>/dev/null)
CMD=$($G repair frontmatter --source notes 2>&1 | grep -oE "apply: gbrain repair .*" | sed 's/^apply: gbrain //')
echo "== apply: $CMD"; $G $CMD 2>&1 | grep -E "applied|repaired"
echo "== after"; $G get people/ivy-example --source-id notes 2>&1 | tail -3; $G get people/jon-example --source-id notes 2>&1 | tail -2
$G pages purges list --source notes 2>&1 | head -2
