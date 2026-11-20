#!/usr/bin/env bash
# Repro: implicit put target flips from the sole git source to 'default' once default holds one page.
set -u
B=/var/tmp/audit/brain.sh; H=/var/tmp/audit/pages/bflip; R=/var/tmp/audit/pages/repoflip
rm -rf $H $R; mkdir -p $R/people; cd $R; git init -q; git config user.email a@example.com; git config user.name audit
printf -- '---\ntitle: Erin Example\ntype: person\n---\n# Erin Example\n\nErin is at acme-example.\n' > people/erin-example.md; git add -A; git commit -qm init
cd /var/tmp/audit/pages
$B $H init --pglite --no-embedding >/dev/null 2>&1
$B $H sources add vault --path $R --federated >/dev/null 2>&1
$B $H sync --source vault --no-embed >/dev/null 2>&1
echo "1) new page, no --source-id:"; echo "# note one" | $B $H put notes/one --content-origin user_said 2>/dev/null | grep -m1 '"source_id"'
echo "2) one page explicitly in default:"; echo "# scratch" | $B $H put notes/scratch --source-id default --content-origin user_said 2>/dev/null | grep -m1 '"source_id"'
echo "3) same kind of put as step 1:"; echo "# note two" | $B $H put notes/two --content-origin user_said 2>&1 | grep -m1 '"source_id"'
echo "4) update existing vault page with --force, no --source-id:"; echo "# Erin Example\n\nErin moved to fund-a." | $B $H put people/erin-example --force --content-origin user_said 2>&1 | grep -m1 '"source_id"'
echo "5) list:"; $B $H list 2>/dev/null
echo "6) get people/erin-example:"; $B $H call get_page '{"slug":"people/erin-example"}' 2>/dev/null | grep -E '"source_id"|"compiled_truth"'
echo "7) vault file still says:"; tail -1 $R/people/erin-example.md
