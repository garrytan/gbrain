/**
 * #9779: the scenarios behind test/long-title-index-9779.test.ts (PGLite) and
 * test/e2e/long-title-index-9779-postgres.test.ts (Postgres). A btree entry
 * must fit in 2,704 bytes, so the old title index refused long titles; the
 * titles here are incompressible (TOAST compression would shrink repetitive
 * text under the limit and hide the bug).
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { exactIdentityStatement } from '../../src/core/engine-sql/exact-identity.ts';
import { PAGES_NAME_LOOKUP_INDEXES } from '../../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import { LEGACY_TITLE_BTREE_INDEX, v326 } from '../../src/core/schema-migrations/v326-pages-title-lower-hash-index.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

export const TITLE_INDEX = PAGES_NAME_LOOKUP_INDEXES[0].name;
const LEGACY_BTREE_SQL = `CREATE INDEX ${LEGACY_TITLE_BTREE_INDEX} ON pages (source_id, lower(title))`;

/** `bytes` ASCII characters a compressor cannot shrink much (a fixed LCG, so runs are repeatable). */
export function incompressibleTitle(bytes: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  let x = seed >>> 0;
  let s = 'Session ';
  while (s.length < bytes) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += alphabet[x % alphabet.length];
  }
  return s.slice(0, bytes);
}

async function indexDef(engine: BrainEngine, name: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ def: string | null }>('SELECT pg_get_indexdef(to_regclass($1)) AS def', [name]);
  return row?.def ?? null;
}

export async function expectReplacedIndexes(engine: BrainEngine): Promise<void> {
  expect(await indexDef(engine, TITLE_INDEX)).toContain('USING hash (lower(title))');
  expect(await indexDef(engine, LEGACY_TITLE_BTREE_INDEX)).toBeNull();
}

/** The exact-title lookups (whois's candidate read and the plain `lower(title) = key` predicate) find the page by its long title. */
export async function expectFoundByTitle(engine: BrainEngine, slug: string, title: string): Promise<void> {
  const { text, params } = exactIdentityStatement({
    probes: { titleKeys: [title.toLowerCase()], titleRaw: title, basenames: [], aliasKeys: [], emails: [] },
    sourceIds: ['default'], types: { types: ['person'], per_source: [] }, limit: 10,
  });
  expect((await engine.executeRaw<{ slug: string }>(text, params)).map(r => r.slug)).toEqual([slug]);
  expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE lower(title) = lower($1)', [title])).map(r => r.slug)).toEqual([slug]);
}

/** The lookup predicate plans an index scan on the hash index once the table is big enough that a scan would cost more. */
export async function expectTitleLookupIndexed(engine: BrainEngine, title: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) SELECT 'default', 'notes/filler-' || g, 'note', 'Filler ' || g
    FROM generate_series(1, 3000) g ON CONFLICT DO NOTHING`);
  await engine.executeRaw('ANALYZE pages');
  const plan = (await engine.executeRaw<Record<string, string>>('EXPLAIN SELECT slug FROM pages WHERE lower(title) = lower($1)', [title]))
    .map(r => Object.values(r)[0]).join('\n');
  expect(plan).toContain(TITLE_INDEX);
  expect(plan).not.toMatch(/Seq Scan on pages\b/);
}

/**
 * A brain at v239 holding pages with a 3,000-byte and a 100 KB title: neither
 * the v240 index nor its btree exists yet. Every later migration runs again.
 */
export async function expectUpgradeFromBeforeV240(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX}`);
  await engine.executeRaw(`DROP INDEX IF EXISTS ${LEGACY_TITLE_BTREE_INDEX}`);
  const short = incompressibleTitle(3_000, 1);
  const long = incompressibleTitle(100_000, 2);
  await engine.putPage('people/long-title-3k', { type: 'person', title: short, compiled_truth: 'Body.' });
  await engine.putPage('people/long-title-100k', { type: 'person', title: long, compiled_truth: 'Body.' });
  await engine.setConfig('version', '239');
  await engine.initSchema();
  expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
  await expectReplacedIndexes(engine);
  await expectFoundByTitle(engine, 'people/long-title-3k', short);
  await expectFoundByTitle(engine, 'people/long-title-100k', long);
  await expectTitleLookupIndexed(engine, long);
}

/** A brain past v240 that built the old btree: v326 replaces it, a long title then saves, and a rerun changes nothing. */
export async function expectReplacementPastV240(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX}`);
  await engine.executeRaw(LEGACY_BTREE_SQL);
  await engine.putPage('people/short-title', { type: 'person', title: 'Alice Example', compiled_truth: 'Body.' });
  await engine.setConfig('version', String(v326.version - 1));
  await engine.initSchema();
  await expectReplacedIndexes(engine);
  const title = incompressibleTitle(3_000, 3);
  await engine.putPage('people/saved-long-title', { type: 'person', title, compiled_truth: 'Body.' });
  await expectFoundByTitle(engine, 'people/saved-long-title', title);
  await expectFoundByTitle(engine, 'people/short-title', 'alice EXAMPLE');
  await v326.handler!(engine);
  await expectReplacedIndexes(engine);
}

async function indexValid(engine: BrainEngine): Promise<boolean | null> {
  const [row] = await engine.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [TITLE_INDEX]);
  return row ? row.valid : null;
}

/** The boot-time replay of schema.sql builds no title index (a plain CREATE INDEX there would block page writes); the migrations own it. */
export async function expectReplayBuildsNoTitleIndex(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX}`);
  await engine.initSchema();
  expect(await indexDef(engine, TITLE_INDEX)).toBeNull();
  await v326.handler!(engine);
  await expectReplacedIndexes(engine);
}

/** A fresh brain ends with the title index present and valid, built by the migrations alone. */
export async function expectFreshBrainHasTitleIndex(engine: BrainEngine): Promise<void> {
  await expectReplacedIndexes(engine);
  expect(await indexValid(engine)).toBe(true);
}

/**
 * Postgres: an interrupted concurrent build leaves an INVALID index under the
 * name. The next upgrade drops and rebuilds it instead of taking it as built.
 */
export async function expectInvalidTitleIndexRebuilt(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX}`);
  await engine.executeRaw(LEGACY_BTREE_SQL);
  await engine.putPage('people/invalid-build', { type: 'person', title: 'Carol Example', compiled_truth: 'Body.' });
  await expect(engine.executeRaw(`CREATE INDEX CONCURRENTLY ${TITLE_INDEX} ON pages USING hash ((1 / (length(title) - length(title))))`))
    .rejects.toThrow('division by zero');
  expect(await indexValid(engine)).toBe(false);
  await engine.setConfig('version', String(v326.version - 1));
  await engine.initSchema();
  await expectReplacedIndexes(engine);
  expect(await indexValid(engine)).toBe(true);
  await expectFoundByTitle(engine, 'people/invalid-build', 'carol example');
}
