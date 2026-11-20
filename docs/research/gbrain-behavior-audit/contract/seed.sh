#!/usr/bin/env bash
# seed.sh <home>
H=$1; B=/var/tmp/audit/brain.sh; D=/var/tmp/audit/contract
rm -rf "$H"; $B $H init --pglite --no-embedding >/dev/null 2>&1 || { echo init-failed; exit 1; }
$B $H put people/alice-example < $D/p-alice.md >/dev/null 2>&1
$B $H put companies/acme-example < $D/p-acme.md >/dev/null 2>&1
$B $H link people/alice-example companies/acme-example --link-type works_at >/dev/null 2>&1
$B $H remember "Alice Example prefers tea over coffee" --entity people/alice-example --provenance user_stated >/dev/null 2>&1
$B $H remember "Acme Example raised a seed round from fund-a" --entity companies/acme-example --provenance user_stated >/dev/null 2>&1
$B $H timeline-add people/alice-example 2025-03-04 "Promoted to chair" >/dev/null 2>&1 || echo "timeline-add failed"
rm -rf "$H.tpl"; cp -a "$H" "$H.tpl"
echo seeded $H
