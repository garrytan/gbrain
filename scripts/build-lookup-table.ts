#!/usr/bin/env bun
/**
 * The "Which gbrain call for which lookup" table (#7233): written once in
 * skills/conventions/brain-first.md and copied verbatim into the other
 * agent entry points, so every agent sees the same calls with the same flags.
 *
 *   bun scripts/build-lookup-table.ts          rewrite the copies
 *   bun scripts/build-lookup-table.ts --check  exit 1 when a copy is stale
 *
 * Source region: `<!-- BEGIN lookup-table -->` .. `<!-- END lookup-table -->`
 * in the brain-first convention. Each copy sits between
 * `<!-- BEGIN GENERATED lookup-table ... -->` and `<!-- END GENERATED lookup-table -->`.
 * The plugin trees copy brain-first.md and RESOLVER.md themselves (regen:all
 * runs this step first); the vendored templates/bootstrap/template-repo/ tree
 * is regenerated from AGENTS.md.template by scripts/generate-template-repo.ts
 * (check-bootstrap-templates.sh diffs it). Wired into regen:all and
 * check:regen-all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SOURCE = 'skills/conventions/brain-first.md';
const COPIES = ['AGENTS.md', 'INSTALL_FOR_AGENTS.md', 'templates/bootstrap/AGENTS.md.template', 'skills/RESOLVER.md'];

const SOURCE_REGION = /<!-- BEGIN lookup-table -->\n([\s\S]*?)<!-- END lookup-table -->/;
const COPY_REGION = /(<!-- BEGIN GENERATED lookup-table[^>]*-->\n)[\s\S]*?(<!-- END GENERATED lookup-table -->)/;

const source = SOURCE_REGION.exec(readFileSync(join(ROOT, SOURCE), 'utf8'));
if (!source) throw new Error(`${SOURCE}: no <!-- BEGIN lookup-table --> region`);
const table = source[1]!;
const check = process.argv.includes('--check');
const stale: string[] = [];
for (const file of COPIES) {
  const path = join(ROOT, file);
  const text = readFileSync(path, 'utf8');
  if (!COPY_REGION.test(text)) throw new Error(`${file}: no <!-- BEGIN GENERATED lookup-table --> region`);
  const next = text.replace(COPY_REGION, (_m, begin: string, end: string) => `${begin}${table}${end}`);
  if (next === text) continue;
  stale.push(file);
  if (!check) writeFileSync(path, next);
}
if (check && stale.length > 0) {
  console.error(`FAIL: the lookup table copy is stale in ${stale.join(', ')}\nWhy: every copy must match the region in ${SOURCE}.\nFix: bun scripts/build-lookup-table.ts (or bun run regen:all)`);
  process.exit(1);
}
console.log(check ? 'lookup table copies are current' : `lookup table: ${stale.length} file(s) rewritten`);
