/**
 * Postgres parity for the CJK keyword OR fallback (#6043) and the bounded arm
 * (#5989): a real statement timeout inside the scoped read transaction rolls
 * back to the savepoint, the capped retry keeps the source scope, and the
 * engine serves the next query normally. The rollback case pins the full
 * attempt's budget (150 ms, far below the >1 s full scoring of this corpus)
 * and gives the capped retry ample time, so its outcome does not depend on
 * load; the default-split case asserts only what holds under any load.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { CjkKeywordMeta } from '../../src/core/engine-sql/cjk-search.ts';

const RUN = hasDatabase();
let engine: PostgresEngine;

async function seed(source: string, slugPrefix: string, pages: number, chunksPerPage: number, body: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT '${slugPrefix}' || i, $1, 'note', 'p' || i, 'x', '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4 FROM generate_series(1, ${pages}) i`, [source]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
    SELECT p.id, c, $1 || ' ' || p.id || '-' || c, 'compiled_truth' FROM pages p CROSS JOIN generate_series(0, ${chunksPerPage - 1}) c
    WHERE p.slug LIKE '${slugPrefix}%'`, [body]);
}

describe.skipIf(!RUN)('CJK keyword arm on Postgres', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('cjk-a', 'cjk-a'), ('cjk-b', 'cjk-b') ON CONFLICT DO NOTHING`);
    await seed('cjk-b', 'cjkb/seats-', 1, 1, '团队版的席位数量由管理员配置。');
    await seed('cjk-b', 'cjkb/upgrade-', 1, 1, '升级到专业版后可以使用更多功能。');
    await seed('cjk-a', 'cjka/p-', 20_000, 8, `${'팀 좌석을 업그레이드하는 방법과 좌석 수 관리, '.repeat(40)}`);
    await engine.executeRaw('ANALYZE content_chunks');
  }, 600_000);
  afterAll(async () => { await teardownDB(); }, 120_000);

  test('OR fallback: terms in different documents found only with the hybrid flag; direct callers keep strict AND', async () => {
    expect(await engine.searchKeyword('席位 升级', { sourceId: 'cjk-b' })).toEqual([]);
    const rows = await engine.searchKeyword('席位 升级', { sourceId: 'cjk-b', orFallback: true });
    expect(rows.map((r) => r.slug).sort()).toEqual(['cjkb/seats-1', 'cjkb/upgrade-1']);
  });

  test('a full scoring that times out rolls back; the capped retry, in a fresh transaction, serves in-scope rows and the engine stays usable', async () => {
    const metas: CjkKeywordMeta[] = [];
    const rows = await engine.searchKeyword('좌석 업그레이드', { sourceId: 'cjk-a', orFallback: true, limit: 20,
      cjkKeyword: { deadlineMs: 30_000, fullBudgetMs: 150, onMeta: (m) => metas.push(m) } });
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ incomplete: true, reason: 'candidate_budget', capped: true });
    // Identical chunk texts tie on score, so the page-grain dedup headroom (innerLimit) decides how many pages survive; any is fine here.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source_id === 'cjk-a')).toBe(true);
    const after = await engine.searchKeyword('席位', { sourceId: 'cjk-b' });
    expect(after.map((r) => r.slug)).toEqual(['cjkb/seats-1']);
  }, 60_000);

  test('with the default split the arm ends near its deadline and reports honestly either way', async () => {
    const metas: CjkKeywordMeta[] = [];
    const started = performance.now();
    const rows = await engine.searchKeyword('좌석 업그레이드', { sourceId: 'cjk-a', orFallback: true, limit: 20,
      cjkKeyword: { deadlineMs: 1500, onMeta: (m) => metas.push(m) } });
    expect(performance.now() - started).toBeLessThan(1500 + 2_000);
    expect(metas[0]?.incomplete).toBe(true);
    expect(rows.every((r) => r.source_id === 'cjk-a')).toBe(true);
  }, 60_000);

  test('a retry that also runs out of time returns no keyword rows with the degraded reason, never an error', async () => {
    const metas: CjkKeywordMeta[] = [];
    const rows = await engine.searchKeyword('좌석 업그레이드', { sourceId: 'cjk-a', orFallback: true,
      cjkKeyword: { deadlineMs: 80, onMeta: (m) => metas.push(m) } });
    expect(rows).toEqual([]);
    expect(metas[0]).toMatchObject({ incomplete: true, reason: 'timeout' });
    expect((await engine.searchKeyword('升级', { sourceId: 'cjk-b' })).map((r) => r.slug)).toEqual(['cjkb/upgrade-1']);
  }, 60_000);
});
