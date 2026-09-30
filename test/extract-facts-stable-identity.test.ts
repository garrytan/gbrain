/**
 * The legacy extract_facts reconcile keys fence rows by row number, the
 * fence's own unique identity, and keeps fact ids stable across edits.
 *
 *   - A claim that reverts to an earlier value (NYC -> SF -> NYC) keeps the
 *     current row active instead of collapsing onto the struck history row.
 *   - An attribute-only edit (notability, visibility, context) updates the row
 *     in place: its id, created_at, source_session and consolidation state
 *     survive, so an id handed out by recall still works for forget.
 *   - A supersession chain (A -> B -> C) links every hop, not only the last.
 *   - Facts of a soft-deleted page leave active recall.
 *
 * Real PGLite, no provider calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';

let engine: PGLiteEngine;

const fence = (rows: string) => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

async function putPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { title: slug, type: 'person', compiled_truth: body, frontmatter: {}, timeline: '' });
}

interface Row { id: number; row_num: number | null; fact: string; expired: boolean; superseded_by: number | null; notability: string; visibility: string }

async function rows(slug: string): Promise<Row[]> {
  return engine.executeRaw<Row>(
    `SELECT id, row_num, fact, expired_at IS NOT NULL AS expired, superseded_by, notability, visibility
       FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id`, [slug]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('UPDATE facts SET superseded_by=NULL');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
});

describe('extract_facts stable identity', () => {
  test('a claim that reverts to an earlier value stays active', async () => {
    const slug = 'people/carol-example';
    await putPage(slug, fence([
      '| 1 | ~~Lives in NYC~~ | fact | 1.0 | world | medium | 2020-01-01 |  | chat | superseded by #2 |',
      '| 2 | ~~Lives in SF~~ | fact | 1.0 | world | medium | 2022-01-01 |  | chat | superseded by #3 |',
      '| 3 | Lives in NYC | fact | 1.0 | world | medium | 2024-01-01 |  | chat |  |',
    ].join('\n')));
    await runExtractFacts(engine, { slugs: [slug] });
    const active = (await rows(slug)).filter(r => !r.expired);
    expect(active.map(r => [Number(r.row_num), r.fact])).toEqual([[3, 'Lives in NYC']]);
  });

  test('every hop of a supersession chain keeps its link', async () => {
    const slug = 'people/dana-example';
    await putPage(slug, fence([
      '| 1 | ~~Works at Acme~~ | fact | 1.0 | world | medium | 2020-01-01 |  | chat | superseded by #2 |',
      '| 2 | ~~Works at Beta~~ | fact | 1.0 | world | medium | 2022-01-01 |  | chat | superseded by #3 |',
      '| 3 | Works at Gamma | fact | 1.0 | world | medium | 2024-01-01 |  | chat |  |',
    ].join('\n')));
    const result = await runExtractFacts(engine, { slugs: [slug] });
    const byRow = new Map((await rows(slug)).map(r => [Number(r.row_num), r]));
    expect(Number(byRow.get(1)!.superseded_by)).toBe(Number(byRow.get(2)!.id));
    expect(Number(byRow.get(2)!.superseded_by)).toBe(Number(byRow.get(3)!.id));
    expect(result.warnings.filter(w => w.includes('itself struck'))).toEqual([]);
    // A second run over the unchanged fence is a no-op.
    const again = await runExtractFacts(engine, { slugs: [slug] });
    expect(again.factsInserted + again.factsDeleted).toBe(0);
  });

  test('a supersession cycle is still rejected', async () => {
    const slug = 'people/erin-example';
    await putPage(slug, fence([
      '| 1 | ~~Likes tea~~ | fact | 1.0 | world | medium | 2020-01-01 |  | chat | superseded by #2 |',
      '| 2 | ~~Likes coffee~~ | fact | 1.0 | world | medium | 2022-01-01 |  | chat | superseded by #1 |',
    ].join('\n')));
    await runExtractFacts(engine, { slugs: [slug] });
    expect((await rows(slug)).map(r => r.superseded_by)).toEqual([null, null]);
  });

  test('an attribute-only edit keeps fact ids and derived state', async () => {
    const slug = 'people/frank-example';
    const v1 = [
      '| 1 | Founded Acme | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |',
      '| 2 | Prefers email | preference | 0.9 | world | medium | 2021-01-01 |  | chat |  |',
    ];
    await putPage(slug, fence(v1.join('\n')));
    await runExtractFacts(engine, { slugs: [slug] });
    const before = await rows(slug);
    await engine.executeRaw(
      `UPDATE facts SET source_session='sess-1', consolidated_at=now() WHERE source_markdown_slug=$1`, [slug]);

    await putPage(slug, fence([
      v1[0],
      '| 2 | Prefers email | preference | 0.9 | private | high | 2021-01-01 |  | chat | said twice |',
    ].join('\n')));
    const result = await runExtractFacts(engine, { slugs: [slug] });
    const after = await rows(slug);
    expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
    expect(after.map(r => [r.notability, r.visibility])).toEqual([['medium', 'world'], ['high', 'private']]);
    expect(result.factsDeleted).toBe(0);
    const derived = await engine.executeRaw<{ source_session: string | null; consolidated: boolean; context: string | null }>(
      `SELECT source_session, consolidated_at IS NOT NULL AS consolidated, context FROM facts
        WHERE source_markdown_slug=$1 ORDER BY id`, [slug]);
    expect(derived.map(d => [d.source_session, d.consolidated])).toEqual([['sess-1', true], ['sess-1', true]]);
    expect(derived[1].context).toBe('said twice');
  });

  test('a removed or rewritten row is expired and detached, never deleted', async () => {
    const slug = 'people/gina-example';
    await putPage(slug, fence([
      '| 1 | Founded Acme | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |',
      '| 2 | Prefers email | preference | 1.0 | world | medium | 2021-01-01 |  | chat |  |',
      '| 3 | Lives in Paris | fact | 1.0 | world | medium | 2021-01-01 |  | chat |  |',
    ].join('\n')));
    await runExtractFacts(engine, { slugs: [slug] });
    const before = await rows(slug);

    await putPage(slug, fence([
      '| 1 | Founded Acme | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |',
      '| 3 | Lives in Lyon | fact | 1.0 | world | medium | 2021-01-01 |  | chat |  |',
    ].join('\n')));
    await runExtractFacts(engine, { slugs: [slug] });
    const after = await rows(slug);
    expect(after.find(r => r.id === before[0].id)).toMatchObject({ row_num: 1, expired: false });
    expect(after.find(r => r.id === before[1].id)).toMatchObject({ row_num: null, expired: true });
    expect(after.find(r => r.id === before[2].id)).toMatchObject({ row_num: null, expired: true, fact: 'Lives in Paris' });
    const lyon = after.find(r => r.fact === 'Lives in Lyon')!;
    expect(lyon).toMatchObject({ expired: false });
    expect(Number(lyon.row_num)).toBe(3);
    const again = await runExtractFacts(engine, { slugs: [slug] });
    expect(again.factsInserted + again.factsDeleted).toBe(0);
  });

  test('facts of a soft-deleted page leave active recall', async () => {
    const slug = 'people/hank-example';
    await putPage(slug, fence('| 1 | CTO at acme-example | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |'));
    await runExtractFacts(engine, { slugs: [slug] });
    await engine.softDeletePage(slug, { sourceId: 'default' });
    await runExtractFacts(engine, {});
    const active = await engine.listFactsByEntity('default', slug, { activeOnly: true });
    expect(active).toEqual([]);
    expect((await rows(slug)).map(r => r.expired)).toEqual([true]);

    // Restoring the page brings its fence back; the next reconcile
    // re-activates the same row, id kept.
    const [before] = await rows(slug);
    await engine.restorePage(slug, { sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [slug] });
    expect((await rows(slug)).map(r => [r.id, r.expired])).toEqual([[before.id, false]]);
  });
});
