#!/usr/bin/env bash
# Repro: a one-word edit_page on a git-synced page rewrites the user's frontmatter (dates, key order, numbers).
set -u
B=/var/tmp/audit/brain.sh; H=/var/tmp/audit/pages/bfm; R=/var/tmp/audit/pages/repofm
rm -rf $H $R; mkdir -p $R/people; cd $R; git init -q; git config user.email a@example.com; git config user.name audit
cat > people/hal-example.md <<'MD'
---
title: Hal Example
type: person
company: acme-example
born: 1990-05-01
last_met: 2024-03-01T10:00:00+02:00
zip: 02134
version: 1.10
details:
  role: cto
  location: berlin
---
# Hal Example

Hal likes tea.
MD
git add -A; git commit -qm init; cd /var/tmp/audit/pages
$B $H init --pglite --no-embedding >/dev/null 2>&1
$B $H sources add vault --path $R --federated >/dev/null 2>&1
$B $H sync --source vault --no-embed >/dev/null 2>&1
REV=$($B $H call get_page '{"slug":"people/hal-example","include_content":true}' 2>/dev/null | grep -m1 '"revision"' | sed 's/.*: "\(.*\)".*/\1/')
$B $H call edit_page "{\"slug\":\"people/hal-example\",\"source_id\":\"vault\",\"expected_revision\":\"$REV\",\"edits\":[{\"old_text\":\"likes tea\",\"new_text\":\"likes coffee\"}]}" 2>&1 | grep -m1 -E '"revision"|"error"'
cd $R; git --no-pager diff people/hal-example.md
