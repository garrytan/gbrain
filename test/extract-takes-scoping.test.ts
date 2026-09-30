/**
 * B-18: the fence -> takes extractor (v0_28_0 migration + fs/db entry points)
 *   - resolves a page within its source and never onto a soft-deleted page,
 *   - re-extracts a slug in every source that holds it (no hard-coded
 *     'default'), and
 *   - removes takes whose rows left a cleanly parsed fence.
 *
 * Hermetic PGLite + tempdir repo.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromDb, extractTakesFromFs } from '../src/core/cycle/extract-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

const fence = (rows: string[]) => `# Page

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
${rows.join('\n')}
${TAKES_FENCE_END}
`;
const row = (n: number, claim: string) => `| ${n} | ${claim} | take | people/alice-example | 0.5 | 2026-01 | manual |`;

async function put(slug: string, body: string, sourceId = 'default'): Promise<number> {
  await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} }, { sourceId });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]);
  return page.id;
}

async function claims(pageId: number): Promise<string[]> {
  return (await engine.executeRaw<{ claim: string }>('SELECT claim FROM takes WHERE page_id=$1 ORDER BY row_num', [pageId])).map(r => r.claim);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM takes');
  await engine.executeRaw('DELETE FROM pages');
});

describe('extract takes scoping (B-18)', () => {
  test('a row removed from the fence is removed from the takes index', async () => {
    const id = await put('concepts/stale-take', fence([row(1, 'Keep me'), row(2, 'Drop me')]));
    await extractTakesFromDb(engine, { slugs: ['concepts/stale-take'] });
    expect(await claims(id)).toEqual(['Keep me', 'Drop me']);
    await put('concepts/stale-take', fence([row(1, 'Keep me')]));
    await extractTakesFromDb(engine, { slugs: ['concepts/stale-take'] });
    expect(await claims(id)).toEqual(['Keep me']);
  });

  test('a slug is re-extracted in every source that holds it', async () => {
    const other = await put('concepts/shared-take', fence([row(1, 'Other source take')]), 'other');
    const mine = await put('concepts/shared-take', fence([row(1, 'Default source take')]));
    await extractTakesFromDb(engine, { slugs: ['concepts/shared-take'] });
    expect(await claims(other)).toEqual(['Other source take']);
    expect(await claims(mine)).toEqual(['Default source take']);
  });

  test('the fs path attaches takes to the page in its own source, never a deleted page', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'extract-takes-scoping-'));
    try {
      mkdirSync(join(repo, 'concepts'), { recursive: true });
      writeFileSync(join(repo, 'concepts/fs-take.md'), fence([row(1, 'From disk')]), 'utf-8');
      const other = await put('concepts/fs-take', 'Other source page.', 'other');
      const mine = await put('concepts/fs-take', 'Default page.');
      await extractTakesFromFs(engine, { repoPath: repo });
      expect(await claims(other)).toEqual([]);
      expect(await claims(mine)).toEqual(['From disk']);

      await engine.executeRaw('DELETE FROM takes');
      await engine.softDeletePage('concepts/fs-take', { sourceId: 'default' });
      const result = await extractTakesFromFs(engine, { repoPath: repo });
      expect(await claims(mine)).toEqual([]);
      expect(result.warnings.some(w => w.startsWith('TAKES_PAGE_NOT_IN_DB'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
