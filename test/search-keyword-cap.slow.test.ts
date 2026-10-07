/**
 * Cat 40 Hard F2: a remote caller paging to the cap. Keyword counts stop at
 * 10,000 (shown as "10000+"), offset 10,000 is the deepest offset any search
 * accepts, and a keyword-mode cursor continues past it. Slow lane: it seeds
 * 10,005 matching pages.
 *
 * Authoring gate: (1) the cap and its model-visible "10000+"; (2) fails if the
 * count loses its LIMIT, reports a wrong number at the cap, or the offset cap
 * moves; (3) the fast suite cannot afford 10,000 pages; (4) no seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { KEYWORD_COUNT_CAP } from '../src/core/search/keyword-statement.ts';
import { withEnv } from './helpers/with-env.ts';
import { callSearch, seedPage } from './helpers/keyword-paging-fixture.ts';

const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

const countLine = (res: ToolResult) => res.content.map(c => c.text).find(t => t.startsWith('[gbrain search] ')) ?? '';
const mcp = (args: Record<string, unknown>) => withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', args, REMOTE));

describe('a remote caller paging to the cap', () => {
  test('counts stop at 10,000 ("10000+"), offset 10,000 is the deepest offset, a cursor goes further', async () => {
    const extra = KEYWORD_COUNT_CAP + 5;
    await seedPage(engine, 'bulk/template', 'The nebulite archive entry.');
    const cols = (await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pages' AND column_name NOT IN ('id', 'slug', 'search_vector') AND is_generated = 'NEVER'`))
      .map(r => r.column_name);
    await engine.executeRaw(`INSERT INTO pages (slug, ${cols.join(', ')}) SELECT 'bulk/p' || g, ${cols.map(c => `t.${c}`).join(', ')}
      FROM pages t, generate_series(1, ${extra - 1}) g WHERE t.slug = 'bulk/template'`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
      SELECT p.id, 0, 'The nebulite archive entry ' || p.slug, 'compiled_truth', 'text' FROM pages p WHERE p.slug LIKE 'bulk/p%'`);
    const hybrid = await mcp({ query: 'nebulite' });
    expect(countLine(hybrid)).toContain('Keyword matches: 10000+ pages');
    const top = await callSearch(engine, { query: 'nebulite', match: 'keyword', limit: 100 });
    expect(top.retrieval).toMatchObject({ total: KEYWORD_COUNT_CAP, total_capped: true, truncated: true });
    const deepest = await callSearch(engine, { query: 'nebulite', match: 'keyword', offset: 10_000, limit: 3 });
    expect(deepest.rows.length).toBe(3);
    expect(JSON.parse((await mcp({ query: 'nebulite', match: 'keyword', offset: 10_001 })).content[0].text).code).toBe('search_offset_over_cap');
    const cursorPage = await callSearch(engine, { ...(deepest.retrieval.next as Record<string, unknown>) });
    expect(cursorPage.rows.length).toBe(2);
    expect(cursorPage.retrieval).toMatchObject({ truncated: false, shown_from: 10_004 });
  }, 120_000);
});
