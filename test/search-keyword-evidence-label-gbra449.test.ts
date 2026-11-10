/**
 * GBRA-449 fix 3: in keyword mode every row a strict keyword statement
 * returned matches the query as the caller wrote it, so it is labelled
 * keyword_exact whatever its normalized ts_rank score.
 *
 * Protects (red before: '"2026-08-04" OR "2026-08-08"' and 'Escalated' with
 * match: "keyword" labelled every row weak_semantic, because their scores sit
 * under SOLID_MATCH_FLOOR):
 *  - the three repro shapes (one quoted date, the caller's own explicit OR, one
 *    word) label every row keyword_exact in keyword mode;
 *  - create_safety keeps the value it had before for every relabelled row
 *    (unknown under the floor, probable above it);
 *  - a row that matched only through the engine's OR relaxation
 *    (keyword_relaxed) or only through an entity name the engine added
 *    (matched_alias) stays weak_semantic under the floor, and so does a
 *    below-floor row outside keyword mode (stampEvidence unit cases);
 *  - hybrid search (the default match) keeps its labels.
 * Database-only (repo-less) brain: pages are imported straight into the
 * database (importFromContent, the put_page import path), no checkout; keyless (no embedding provider). PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { SOLID_MATCH_FLOOR, stampEvidence } from '../src/core/search/evidence.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

type Row = { slug: string; evidence: string; create_safety: string; score: number };

describe('stampEvidence keyword mode (GBRA-449)', () => {
  const row = (extra: Partial<SearchResult>) => ({ slug: 'contracts/c1', score: 0.2, base_score: 0.2, keyword_hit: true, ...extra }) as SearchResult;
  test('a strict keyword row under the floor is keyword_exact with the create_safety it had (unknown)', () => {
    const r = row({});
    stampEvidence([r], { keywordMode: true });
    expect([r.evidence, r.create_safety]).toEqual(['keyword_exact', 'unknown']);
  });
  test('a strict keyword row at the floor keeps keyword_exact and probable', () => {
    const r = row({ score: SOLID_MATCH_FLOOR, base_score: SOLID_MATCH_FLOOR });
    stampEvidence([r], { keywordMode: true });
    expect([r.evidence, r.create_safety]).toEqual(['keyword_exact', 'probable']);
  });
  test('an OR-relaxed row stays weak_semantic in keyword mode', () => {
    const r = row({ keyword_relaxed: true, score: 0.9, base_score: 0.9 });
    stampEvidence([r], { keywordMode: true });
    expect([r.evidence, r.create_safety]).toEqual(['weak_semantic', 'unknown']);
  });
  test('a row that matched only an entity name the engine added (matched_alias) keeps the floor in keyword mode', () => {
    const r = row({ matched_alias: 'Acme Example' });
    stampEvidence([r], { keywordMode: true });
    expect([r.evidence, r.create_safety]).toEqual(['weak_semantic', 'unknown']);
  });
  test('a row with no keyword_hit stays weak_semantic in keyword mode', () => {
    const r = row({ keyword_hit: undefined });
    stampEvidence([r], { keywordMode: true });
    expect([r.evidence, r.create_safety]).toEqual(['weak_semantic', 'unknown']);
  });
  test('outside keyword mode the floor still applies', () => {
    const r = row({});
    stampEvidence([r]);
    expect([r.evidence, r.create_safety]).toEqual(['weak_semantic', 'unknown']);
  });
});

for (const backend of testBackends()) {
  describe('[' + backend + '] search match: keyword labels the caller\'s own matches keyword_exact (GBRA-449)', () => {
    let engine: BrainEngine;
    const config = { engine: backend } as never;
    const local = { remote: false, sourceId: 'default', config };
    const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
      __setEmbedTransportForTests(null);
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    }, 180_000);
    afterAll(async () => { resetGateway(); await engine.disconnect(); });

    const put = (slug: string, type: string, body: string) =>
      importFromContent(engine, slug, ['---', 'type: ' + type, 'title: ' + slug, '---', body, ''].join('\n'), { noEmbed: true });

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await put('contracts/c1', 'contract', 'Renewal date: 2026-08-04.');
      await put('contracts/c2', 'contract', 'Renewal date: 2026-08-08.');
      for (let i = 1; i <= 6; i++) await put('tickets/t' + i, 'ticket', 'Ticket ' + i + ' status: Escalated to tier two.');
    });

    async function search(query: string, extra: Record<string, unknown>, opts: Record<string, unknown> = local): Promise<Row[]> {
      const r = await dispatchToolCall(engine, 'search', { query, ...extra }, opts as never);
      expect(r.isError).not.toBe(true);
      const body = JSON.parse(r.content[0]!.text);
      return (Array.isArray(body) ? body : body.results) as Row[];
    }
    const labels = (rows: Row[]) => rows.map(r => r.slug + ' ' + r.evidence + ' ' + r.create_safety).sort();

    test('one quoted date: keyword_exact, create_safety unchanged (probable above the floor)', async () => {
      const rows = await search('"2026-08-04"', { match: 'keyword' });
      expect(labels(rows)).toEqual(['contracts/c1 keyword_exact probable']);
    });

    test('the caller\'s own OR and a single word: every row keyword_exact, create_safety stays unknown', async () => {
      for (const opts of [local, remote]) {
        const or = await search('"2026-08-04" OR "2026-08-08"', { match: 'keyword' }, opts);
        expect(labels(or)).toEqual(['contracts/c1 keyword_exact unknown', 'contracts/c2 keyword_exact unknown']);
        expect(or.every(r => r.score < SOLID_MATCH_FLOOR)).toBe(true);
        const word = await search('Escalated', { match: 'keyword' }, opts);
        expect(labels(word)).toEqual([1, 2, 3, 4, 5, 6].map(i => 'tickets/t' + i + ' keyword_exact unknown'));
      }
    });

    test('a keyword query no page satisfies is not relaxed into weak rows', async () => {
      expect(await search('Escalated zebra', { match: 'keyword' })).toEqual([]);
    });

    test('hybrid search (default match) keeps its labels', async () => {
      expect(labels(await search('"2026-08-04" OR "2026-08-08"', {}))).toEqual(['contracts/c1 weak_semantic unknown', 'contracts/c2 weak_semantic unknown']);
      expect(labels(await search('Escalated', {}))).toEqual([1, 2, 3, 4, 5, 6].map(i => 'tickets/t' + i + ' weak_semantic unknown'));
    });
  });
}
