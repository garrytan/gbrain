#!/usr/bin/env bun
/**
 * Migration search-index guard (#9192).
 *
 * A schema migration that bulk-changes what the page revision trigger watches
 * clears every touched page's text projection, so those pages leave keyword and
 * vector search until 'gbrain projections drain' rebuilds them. On a large brain
 * reached over the network that is hours of empty search (v153 did exactly this).
 * This guard loads the migration registry and fails on a migration whose SQL, or
 * whose handler's own source text, does either of:
 *
 *   1. 'UPDATE pages ... SET' assigning a watched column: source_id, slug, type,
 *      page_kind, title, compiled_truth, timeline, frontmatter, deleted_at,
 *      body_generation, knowledge_revision or text_projection_revision;
 *   2. 'INSERT INTO tags', 'UPDATE tags' or 'DELETE FROM tags' (the tags trigger
 *      advances the page revision).
 *
 * The body of a CREATE FUNCTION or CREATE PROCEDURE is skipped, since defining a
 * trigger function changes no row; a DO block is read.
 *
 * Unless scripts/migration-projection-baseline.tsv lists it with the reason
 * search keeps answering, or why it cannot. A listed migration that no longer
 * matches (or no longer exists) fails as stale.
 *
 * What it cannot see: a handler that changes pages through engine helpers or
 * functions defined elsewhere (only the handler's own source text is read), SQL
 * assembled at run time from pieces, and writes through a database function the
 * migration calls. Review those by hand.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const REGISTRY = 'src/core/schema-migrations/registry.generated.ts';
const BASELINE = 'scripts/migration-projection-baseline.tsv';
const WATCHED = new Set(['source_id', 'slug', 'type', 'page_kind', 'title', 'compiled_truth', 'timeline', 'frontmatter',
  'deleted_at', 'body_generation', 'knowledge_revision', 'text_projection_revision']);

type Migration = { version: number; name: string; sql?: string; sqlFor?: { postgres?: string; pglite?: string }; handler?: unknown };

/** Drops line comments and the bodies of CREATE FUNCTION / PROCEDURE: defining a trigger function changes no row (a DO block still counts). */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, ' ')
    .replace(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*?(\$\w*\$)[\s\S]*?\1/gi, ' ');
}

/** The SET list after an 'UPDATE pages [alias] SET', cut at the first top-level WHERE, FROM, RETURNING or ';'. */
function setList(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '\x60') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) return text.slice(from, i); depth--; }
    else if (depth === 0 && (c === ';' || /^(WHERE|FROM|RETURNING)\b/i.test(text.slice(i, i + 9)) && /\W/.test(text[i - 1] ?? ' '))) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Columns a SET list assigns: each top-level item's 'col =' or '(col, col) ='. */
function assigned(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '\x60') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { items.push(list.slice(start, i)); start = i + 1; }
  }
  items.push(list.slice(start));
  const cols: string[] = [];
  for (const item of items) {
    const m = /^\s*(\([^)]*\)|"?\w+"?)\s*=/.exec(item);
    if (m) for (const col of m[1]!.replace(/[()"]/g, '').split(',')) cols.push(col.trim().toLowerCase());
  }
  return cols;
}

function findings(text: string): string[] {
  const out: string[] = [];
  const body = stripComments(text);
  const update = /\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?pages\b(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b/gi;
  for (let m: RegExpExecArray | null; (m = update.exec(body));) {
    const hit = assigned(setList(body, m.index + m[0].length)).filter(col => WATCHED.has(col));
    if (hit.length) out.push('UPDATE pages SET ' + [...new Set(hit)].join(', '));
  }
  const tags = /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:public\.)?tags\b/gi;
  for (let m: RegExpExecArray | null; (m = tags.exec(body));) out.push(m[1]!.replace(/\s+/g, ' ').toUpperCase() + ' tags');
  return [...new Set(out)];
}

const registryPath = join(ROOT, REGISTRY);
if (!existsSync(registryPath)) {
  console.log('GBRAIN_CHECK_SKIPPED: no migration registry at ' + REGISTRY);
  process.exit(0);
}
const { MIGRATIONS } = await import(registryPath) as { MIGRATIONS: Migration[] };
const baseline = new Map<number, { name: string; reason: string }>();
const baselinePath = join(ROOT, BASELINE);
if (existsSync(baselinePath)) {
  for (const line of readFileSync(baselinePath, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [version, name, reason] = line.split('\t');
    if (!reason?.trim()) { console.error('check-migration-projection: ' + BASELINE + ' row without a reason: ' + line); process.exit(1); }
    baseline.set(Number(version), { name: name!, reason });
  }
}

const violations: string[] = [];
const matched = new Set<number>();
for (const m of MIGRATIONS) {
  const texts = [m.sql ?? '', m.sqlFor?.postgres ?? '', m.sqlFor?.pglite ?? '', typeof m.handler === 'function' ? m.handler.toString() : ''];
  const hits = [...new Set(texts.flatMap(findings))];
  if (!hits.length) continue;
  const row = baseline.get(m.version);
  if (row && row.name === m.name) { matched.add(m.version); continue; }
  violations.push('v' + m.version + ' ' + m.name + ': ' + hits.join('; '));
}
for (const [version, row] of baseline) {
  if (!matched.has(version)) violations.push('stale baseline row v' + version + ' ' + row.name + ': that migration no longer changes what the page revision trigger watches (or is gone); delete the row');
}
if (violations.length) {
  for (const v of violations) console.error('  ' + v);
  console.error('check-migration-projection: ' + violations.length + ' violation(s)');
  console.error('A migration that changes what the page revision trigger watches clears those pages\' text projection: they leave search until');
  console.error('gbrain projections drain rebuilds them (#9192). Keep it out of the migration, limit it to pages that were not searchable,');
  console.error('or add a row to ' + BASELINE + ' saying how search keeps answering (or why it cannot).');
  process.exit(1);
}
console.log('check-migration-projection: ok (' + MIGRATIONS.length + ' migrations, ' + matched.size + ' baseline rows)');
