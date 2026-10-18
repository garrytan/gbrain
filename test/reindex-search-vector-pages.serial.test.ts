/**
 * #6374: `gbrain reindex-search-vector` rebuilds PAGE keyword vectors.
 *
 * Protects: after a language change every existing page is retokenized in the
 * new language, through the seal's own expression over the sanitized timeline,
 * so private, withdrawn and takes fence text (and a malformed fence) never
 * enter the page vector. A page edited between the batch read and its write is
 * skipped (its own seal indexes it), and a failed batch keeps the in-progress
 * marker so the run resumes. Fails on the tree before the fix: the backfill
 * was `UPDATE pages SET id = id`, which never fires the
 * `UPDATE OF title,timeline` trigger, so pages kept their old-language stems.
 *
 * SERIAL: mutates GBRAIN_FTS_LANGUAGE.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexSearchVector } from '../src/commands/reindex-search-vector.ts';
import { resetFtsLanguageCache, FTS_REINDEX_MARKER_KEY } from '../src/core/fts-language.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const saved = process.env[ENV_KEY];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved;
  resetFtsLanguageCache();
});

async function page(slug: string, title: string, timeline = ''): Promise<void> {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: 'body', timeline, frontmatter: {} });
}
async function vector(slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ v: string }>(`SELECT search_vector::text AS v FROM pages WHERE slug=$1`, [slug]);
  return row!.v;
}
async function reindex(lang: string) {
  process.env[ENV_KEY] = lang;
  resetFtsLanguageCache();
  return runReindexSearchVector(engine, { yes: true, json: true });
}

describe('reindex-search-vector page vectors (#6374)', () => {
  test('an existing page is retokenized in the new language', async () => {
    await page('notes/runners', 'Running runners');
    expect(await vector('notes/runners')).toContain("'run'");
    await reindex('simple');
    const v = await vector('notes/runners');
    expect(v).toContain("'running'");
    expect(v).toContain("'runners'");
    expect(v).not.toContain("'run':");
  });

  test('private, withdrawn, takes and malformed fence text never enters the page vector', async () => {
    const facts = renderFactsTable([
      { rowNum: 1, claim: 'worldcanary fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
      { rowNum: 2, claim: 'privatecanary fact', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
      { rowNum: 3, claim: 'withdrawncanary fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: false, forgotten: true, context: 'forgotten: user asked' },
    ]);
    expect(facts).toContain(FACTS_FENCE_BEGIN);
    expect(facts).toContain(FACTS_FENCE_END);
    const takes = `${TAKES_FENCE_BEGIN}\n| # | claim |\n|---|---|\n| 1 | takescanary |\n${TAKES_FENCE_END}`;
    const timeline = `- 2026-10-01 publiccanary meeting\n${facts}\n${takes}\n${FACTS_FENCE_BEGIN}\nmalformedcanary never closed`;
    await page('notes/fenced', 'Fenced page', timeline);
    await reindex('simple');
    const v = await vector('notes/fenced');
    expect(v).toContain("'publiccanary'");
    expect(v).toContain("'worldcanary'");
    for (const hidden of ['privatecanary', 'withdrawncanary', 'takescanary', 'malformedcanary']) expect(v).not.toContain(hidden);
  });

  test('a page edited between the batch read and its write is skipped, not overwritten', async () => {
    await page('notes/a', 'Running alpha');
    await page('notes/b', 'Running beta');
    const real = engine.executeRaw.bind(engine);
    const spy = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
      const out = await real(sql, params);
      if (/UPDATE pages SET id = id/.test(sql)) {
        // A concurrent edit lands after the batch read: the trigger reindexes it under the new trigger language.
        await real(`UPDATE pages SET timeline='- 2026-10-02 walking' WHERE slug='notes/b'`);
      }
      return out;
    }) as typeof engine.executeRaw);
    try {
      await reindex('simple');
    } finally {
      spy.mockRestore();
    }
    expect(await vector('notes/a')).toContain("'running'");
    // The edit's own timeline survives: the batch's write, built from the timeline it read, skipped this page.
    expect(await vector('notes/b')).toContain("'walking'");
  });

  test('a failed page batch keeps the marker; the rerun resumes and completes', async () => {
    await page('notes/runners', 'Running runners');
    const real = engine.executeRaw.bind(engine);
    const spy = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/unnest\(\$1::int\[\]/.test(sql)) throw new Error('injected batch failure');
      return real(sql, params);
    }) as typeof engine.executeRaw);
    try {
      await expect(reindex('simple')).rejects.toThrow('injected batch failure');
    } finally {
      spy.mockRestore();
    }
    expect(await engine.getConfig(FTS_REINDEX_MARKER_KEY)).toBe('simple');
    await reindex('simple');
    expect(await engine.getConfig(FTS_REINDEX_MARKER_KEY)).toBeNull();
    expect(await vector('notes/runners')).toContain("'running'");
  });
});
