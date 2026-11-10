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
 *  - hybrid search (the default match) keeps its labels;
 *  - a cursor page labels the caller's own matches keyword_exact as page 1 does;
 *  - a query that is an entity's name (searched under every name the entity
 *    goes by) keeps master's score-floor labels on every page: a row found
 *    only under another name written with different punctuation
 *    ("Copper-Fox" for the alias "Copper Fox") is not keyword_exact, and
 *    neither is the page whose title holds the entity's own name.
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
import { resetMentionBrain, sweep } from './helpers/mention-brain.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

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

    test('a cursor page labels the caller\'s own matches keyword_exact, as page 1 does', async () => {
      for (const [query, limit] of [['"2026-08-04" OR "2026-08-08"', 1], ['Escalated', 2]] as const) {
        const pages: Row[][] = [];
        let next: Record<string, unknown> | undefined = { query, match: 'keyword', limit };
        while (next) {
          const r = await dispatchToolCall(engine, 'search', next, remote as never);
          expect(r.isError).not.toBe(true);
          pages.push(JSON.parse(r.content[0]!.text) as Row[]);
          next = (r._meta?.retrieval as { next?: Record<string, unknown> } | undefined)?.next;
        }
        expect(pages.length).toBeGreaterThan(1);
        for (const rows of pages) for (const r of rows) expect(r.evidence).toBe('keyword_exact');
      }
    });

    test('hybrid search (default match) keeps its labels', async () => {
      expect(labels(await search('"2026-08-04" OR "2026-08-08"', {}))).toEqual(['contracts/c1 weak_semantic unknown', 'contracts/c2 weak_semantic unknown']);
      expect(labels(await search('Escalated', {}))).toEqual([1, 2, 3, 4, 5, 6].map(i => 'tickets/t' + i + ' weak_semantic unknown'));
    });
  });
}

for (const backend of testBackends()) {
  describe('[' + backend + '] search match: keyword on an entity\'s name keeps master\'s labels (GBRA-449)', () => {
    let engine: BrainEngine;
    const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config: { engine: backend } as never };

    beforeAll(async () => {
      setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
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
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
    }, 180_000);
    afterAll(async () => { await engine.disconnect(); });

    const put = (slug: string, type: string, title: string, body: string) =>
      importFromContent(engine, slug, ['---', 'type: ' + type, 'title: "' + title + '"', '---', body, ''].join('\n'), { noEmbed: true, forceRechunk: true });

    beforeEach(async () => {
      await resetMentionBrain(engine);
      await put('accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Internal nickname: Copper Fox');
      await put('tickets/t2', 'ticket', 'Ticket 2', 'Copper-Fox asked about the invoice.');
      await put('tickets/t1', 'ticket', 'Ticket 1', 'Copper Fox asked for a refund.');
      for (let i = 0; i < 3; i++) await put('notes/n' + i, 'note', 'Note ' + i, 'Weekly check-in number ' + i + ' with Widget Co.');
      await sweep(engine);
    });

    async function walk(limit: number) {
      const rows: Array<Row & { matched_alias?: string; page: number }> = [];
      let next: Record<string, unknown> | undefined = { query: 'Widget Co', match: 'keyword', limit };
      for (let page = 0; next; page++) {
        const r = await dispatchToolCall(engine, 'search', next, remote as never);
        expect(r.isError).not.toBe(true);
        for (const row of JSON.parse(r.content[0]!.text) as Array<Row & { matched_alias?: string }>) rows.push({ ...row, page });
        next = (r._meta?.retrieval as { next?: Record<string, unknown> } | undefined)?.next;
      }
      return rows;
    }

    test('a row found only under another name written with other punctuation, and the page titled with the entity\'s own name, keep the floor label', async () => {
      const rows = await walk(10);
      const bySlug = new Map(rows.map(r => [r.slug, r]));
      for (const slug of ['tickets/t2', 'accounts/widget-co']) {
        const r = bySlug.get(slug)!;
        expect(r).toBeDefined();
        expect(r.score).toBeLessThan(SOLID_MATCH_FLOOR);
        expect(r.evidence).toBe('weak_semantic');
      }
    });

    test('every page of the walk keeps the floor labels, and page 2 on still marks rows found only under another name', async () => {
      const rows = await walk(1);
      expect(rows.length).toBeGreaterThan(2);
      for (const r of rows) if (r.score < SOLID_MATCH_FLOOR) expect(r.evidence).toBe('weak_semantic');
      const t1 = rows.find(r => r.slug === 'tickets/t1')!;
      expect(t1.page).toBeGreaterThan(0);
      expect(t1.matched_alias).toBe('Copper Fox');
      expect(t1.evidence).toBe('weak_semantic');
    });
  });
}
