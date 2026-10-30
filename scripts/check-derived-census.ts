#!/usr/bin/env bun
/**
 * Derived-retirement census (GBRA-161 PR 1a; docs/architecture/generations.md#census).
 *
 * Every derived producer is moving onto the generation primitive (src/core/generations/), the one path that retires a
 * derived item only inside the activation of a complete successor. Until each has moved, this guard keeps the set of
 * code that soft-deletes pages from growing unnoticed. It counts, per src file (generated files excluded):
 *
 *   - calls to softDeletePage(, softDeletePages(, retireDerivedPages( and retireDerivedPagesInTransaction(;
 *   - SQL that sets pages.deleted_at (`UPDATE pages ... deleted_at =`).
 *
 * Rules (every violation is reported, then one exit):
 *   1. growth: a file with more sites than its reviewed ceiling, or with sites and no row     -> FAIL
 *   2. stale:  a row whose file is gone or now has fewer sites than its ceiling              -> FAIL
 *   3. class:  a row whose class is not one of CLASSES, or a malformed row                   -> FAIL
 *
 * Baseline: docs/architecture/derived-census.tsv, rows `path<TAB>ceiling<TAB>class<TAB>note`. Ceilings only shrink.
 * `--prune` lowers each ceiling to the current count and drops rows that reached zero; nothing ever adds rows.
 * GBRAIN_GUARD_ROOT points the scan at a fixture tree (scripts/guard-self-test.sh).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE = 'docs/architecture/derived-census.tsv';
/** primitive: the generation primitive and its retirement helper; engine: the storage method itself; canonical: deletes
 *  of canonical pages a user or sync asked for; pending:inventory: a derived or mixed writer not yet reviewed onto the primitive. */
const CLASSES = new Set(['primitive', 'engine', 'canonical', 'pending:inventory']);
const CALL = /(?<![\w$])(?:softDeletePages?|retireDerivedPages(?:InTransaction)?)\s*(?:\?\.)?\s*\(/g;
const SQL = /\bUPDATE\s+pages\b[^;`]{0,400}?\bdeleted_at\s*=/gi;

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name))
    : entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [join(directory, entry.name)] : []);
}

const counts = new Map<string, number>();
for (const file of files(join(root, 'src'))) {
  const body = readFileSync(file, 'utf8');
  const sites = [...body.matchAll(CALL)].length + [...body.matchAll(SQL)].length;
  if (sites) counts.set(relative(root, file), sites);
}

const baselinePath = join(root, BASELINE);
const lines = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8').split('\n') : [];
const problems: string[] = [];
const rows = new Map<string, { ceiling: number; cls: string; note: string; line: string }>();
for (const line of lines) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [path, ceiling, cls, note] = line.split('\t');
  if (!path || !/^\d+$/.test(ceiling ?? '') || !cls || !note) { problems.push(`malformed row: ${line}`); continue; }
  if (rows.has(path)) { problems.push(`duplicate row: ${path}`); continue; }
  if (!CLASSES.has(cls)) problems.push(`${path}: class "${cls}" is not one of ${[...CLASSES].join(', ')}`);
  rows.set(path, { ceiling: Number(ceiling), cls, note, line });
}

if (process.argv.includes('--prune')) {
  const kept = lines.filter(line => {
    if (!line.trim() || line.startsWith('#')) return true;
    const path = line.split('\t')[0]!;
    return (counts.get(path) ?? 0) > 0;
  }).map(line => {
    if (!line.trim() || line.startsWith('#')) return line;
    const [path, ceiling, ...rest] = line.split('\t');
    const now = counts.get(path!) ?? 0;
    return now < Number(ceiling) ? [path, String(now), ...rest].join('\t') : line;
  });
  writeFileSync(baselinePath, kept.join('\n'));
  console.log(`check-derived-census: pruned ${BASELINE}`);
  process.exit(0);
}

for (const [path, sites] of counts) {
  const row = rows.get(path);
  if (!row) problems.push(`growth: ${path} has ${sites} derived-retire site(s) and no reviewed row`);
  else if (sites > row.ceiling) problems.push(`growth: ${path} has ${sites} derived-retire site(s); reviewed ceiling ${row.ceiling}`);
}
for (const [path, row] of rows) {
  const sites = counts.get(path) ?? 0;
  if (sites < row.ceiling) problems.push(`stale: ${path} has ${sites} derived-retire site(s); its ceiling ${row.ceiling} must shrink (bun scripts/check-derived-census.ts --prune)`);
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  console.error('Why:  a derived producer retires items only through the generation primitive (publishGeneration); a new soft-delete site needs a reviewed row.');
  console.error('See:  docs/architecture/generations.md#census');
  console.error(`check-derived-census: ${problems.length} violation(s)`);
  process.exit(1);
}
console.log(`check-derived-census: ok (${rows.size} reviewed rows)`);
