/**
 * #5742: a page about a historical work keeps its explicit pre-1990 date
 * through the write path, and `gbrain reindex-frontmatter` recomputes pages
 * stored under the old 1990 floor (source `fallback`, dated by ingest time).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const SLUG = 'sources/books/moby-dick';
const PAGE = "---\ntype: source\ntitle: 'Moby-Dick; or, The Whale'\nauthor: Herman Melville\nevent_date: '1851-10-18'\n---\n\nCall me Ishmael.\n";

async function stored() {
  const [row] = await engine.executeRaw<{ effective_date: string; effective_date_source: string }>(
    `SELECT to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS effective_date, effective_date_source FROM pages WHERE slug = $1`, [SLUG]);
  return row;
}

test('an explicit 1851 event_date is stored as the effective date', async () => {
  await importFromContent(engine, SLUG, PAGE, { noEmbed: true });
  expect(await stored()).toEqual({ effective_date: '1851-10-18', effective_date_source: 'event_date' });
});

test('reindex-frontmatter recomputes a page stored under the old floor', async () => {
  await importFromContent(engine, SLUG, PAGE, { noEmbed: true });
  await engine.executeRaw(`UPDATE pages SET effective_date = created_at, effective_date_source = 'fallback' WHERE slug = $1`, [SLUG]);
  // C3: an apply binds the previewed plan (--yes --expect <plan_hash>).
  const { plan_hash } = await runReindexFrontmatter(engine, { dryRun: true, json: true });
  const result = await runReindexFrontmatter(engine, { yes: true, expect: plan_hash, json: true });
  expect(result.updated).toBe(1);
  expect(await stored()).toEqual({ effective_date: '1851-10-18', effective_date_source: 'event_date' });
});
