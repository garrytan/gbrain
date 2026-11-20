#!/usr/bin/env bash
# Repro: gbrain delete (soft) removes the file; user restores it with git checkout; sync never re-imports it.
set -u
L=/var/tmp/audit/lifecycle; G="$L/g.sh h4"
rm -rf $L/h4 $L/repo2; mkdir -p $L/repo2/people
cd $L/repo2 && git init -q -b main && git config user.email a@example.com && git config user.name audit
printf -- '---\ntitle: Eve Example\ntype: person\n---\n# Eve Example\n\nEve note. Platypus keyword.\n' > people/eve-example.md
git add -A && git commit -qm init
$G init --pglite --no-embedding >/dev/null 2>&1
$G sources add notes --path $L/repo2 >/dev/null 2>&1
$G sync --source notes --no-pull 2>&1 | grep -E "imported|added"
echo "== delete (soft)"; $G delete people/eve-example --source-id notes --force 2>&1 | grep -m1 '"status"'
git -C $L/repo2 status --short
echo "== user restores the file"; git -C $L/repo2 checkout -- people/eve-example.md; git -C $L/repo2 status --short; ls $L/repo2/people
echo "== sync"; $G sync --source notes --no-pull 2>&1 | grep -vE "watchdog|gitignore"
echo "== search Platypus"; $G search Platypus 2>&1 | grep -E "^\[0|No results"
echo "== retention purge"; $G pages purge-deleted --older-than 0h --yes --json 2>&1 | tr -d '\n ' ; echo
echo "== sync after purge"; $G sync --source notes --no-pull 2>&1 | grep -vE "watchdog|gitignore"
ls $L/repo2/people; git -C $L/repo2 status --short
echo "== sources status"; $G sources status notes 2>&1 | grep -E "notes"
echo "== unindexed detector"; timeout 200 $G dream --phase unindexed_files --json 2>/dev/null | python3 -c "import json,sys; [print(p['summary']) for p in json.load(sys.stdin)['phases']]"
echo "== sync after detector"; $G sync --source notes --no-pull 2>&1 | grep -vE "watchdog|gitignore"
echo "== get"; $G get people/eve-example --source-id notes --include-deleted 2>&1 | head -1
