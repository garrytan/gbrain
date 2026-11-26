/**
 * #9936: keyword-only CJK search (`search --match keyword` and
 * `search.mcp_keyword_only`) ran one unbounded CJK statement, so a statement
 * timeout on a large brain surfaced as internal_error. Both paths now end
 * like the hybrid arm (#5989): rows or none, stamped degraded
 * `keyword_candidates_incomplete`, never an error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const RUN = hasDatabase();
const SRC = 'cjk-kwonly';
let engine: PostgresEngine;

async function search(params: Record<string, unknown>) {
  return dispatchToolCall(engine, 'search', { query: '좌석 업그레이드', limit: 5, source_id: SRC, ...params }, { remote: false, sourceId: SRC });
}

describe.skipIf(!RUN)('keyword-only CJK search under a statement timeout (#9936)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [SRC]);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'kwonly/p-' || i, $1, 'note', 'p' || i, 'x', '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid, 4 FROM generate_series(1, 20000) i`, [SRC]);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
      SELECT p.id, c, $1 || ' ' || p.id || '-' || c, 'compiled_truth' FROM pages p CROSS JOIN generate_series(0, 7) c
      WHERE p.source_id = $2`, [`${'팀 좌석을 업그레이드하는 방법과 좌석 수 관리, '.repeat(40)}`, SRC]);
    await engine.executeRaw('ANALYZE content_chunks');
    await engine.setConfig('search.keyword_statement_timeout_ms', '1000');
    await engine.setConfig('search.cjk_keyword_deadline_ms', '500');
    (engine as unknown as { keywordStatementTimeout?: unknown }).keywordStatementTimeout = undefined;
  }, 600_000);
  afterAll(async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.keyword_statement_timeout_ms', 'search.cjk_keyword_deadline_ms', 'search.mcp_keyword_only')`);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [SRC]);
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [SRC]);
    await teardownDB();
  }, 120_000);

  test('search --match keyword: a timed-out CJK read is degraded, not internal_error', async () => {
    const out = await search({ match: 'keyword' });
    expect({ error: out.isError ? String(out.content[0]?.text).slice(0, 160) : null }).toEqual({ error: null });
    expect(JSON.stringify(out)).toContain('keyword_candidates_incomplete');
  }, 60_000);

  test('search.mcp_keyword_only: the CJK keyword read is bounded and degraded, not internal_error', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    const out = await search({});
    expect({ error: out.isError ? String(out.content[0]?.text).slice(0, 160) : null }).toEqual({ error: null });
    expect(JSON.stringify(out)).toContain('keyword_candidates_incomplete');
  }, 60_000);
});
